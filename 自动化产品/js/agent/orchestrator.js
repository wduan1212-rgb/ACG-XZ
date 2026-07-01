/* 批次编排器：事件驱动的状态机（替代 v4 的 setInterval 盯进度）
   会话/消息/批次全部持久化，刷新后 resumeActiveBatches() 接续 */

import { state, save, emit, on, notify, accountById, productionById, productById, primaryProductById, ownedBy, removeRemote } from "../core/store.js";
import { uid, runPool, debounce } from "../core/util.js";
import { AI } from "../api/ai.js";
import { buildSbExternalPrompt, buildImgExternalPrompt, buildSbExternalGroups } from "../api/prompts.js";
import { groupOf, tagsOf, TAG_POOL } from "../domain/accounts.js";
import { createProduction, setStage, setStatus, autoAssemble, jobsOf, isMaterial, isVideoWorkshop, estimateAudio, buildMaterialUnits, shotsToText } from "../domain/productions.js";
import { createRenderJobsFor, retryJob, createJob } from "../api/jobs.js";
import { deliver } from "../domain/delivery.js";
import { addAssetFromDataUrl, addAssetFromFile, assetBlob, urlFor } from "../domain/assets.js";
import { activeProviderFor, imageApiConfigured, providerKeyFor } from "../api/providers.js";
import { routeIntent, parseGoalFallback } from "./intent.js";
import { fileToDataUrl } from "../core/util.js";

const DEFAULT_XHS_IMAGE_COUNT = 4;
const IMAGE_NEGATIVE_PROMPT = "负面约束：不出现页码，不出现二维码，图片右上角和左上角不要加入logo，其他位置可以正常出现logo。";
const activeImageRecoveries = new Set();

function promptProductName(product = null) {
  const text = `${product?.id || ""} ${product?.name || ""} ${product?.shortName || ""}`;
  if (/miaoda|秒哒/i.test(text)) return "百度秒哒";
  if (/dumate|百度搭子|搭子/i.test(text)) return "百度搭子";
  return (product?.shortName || product?.name || "").replace(/Dumate|DuMate/gi, "百度搭子").replace(/MIAODA/gi, "百度秒哒");
}

const BATCH_CREATIVE_VARIANTS = [
  { key: "pain-relief", name: "痛点急救型", angle: "从一个具体办公痛点切入，讲清这条内容解决哪种麻烦", focus: "痛点现场、具体动作、结果变化" },
  { key: "tool-division", name: "工具分工型", angle: "讲同类/互补工具和主产品如何分工，不孤立宣传", focus: "工具边界、组合流程、主产品负责的动作" },
  { key: "real-test", name: "真实实测型", angle: "像真实博主试完后复盘，优点和边界都说一点", focus: "实测过程、有效证据、适用/不适用" },
  { key: "template-save", name: "模板收藏型", angle: "把内容做成可收藏复用的流程卡或模板", focus: "模板字段、复用步骤、适用场景" },
  { key: "mistake-fix", name: "避坑修正型", angle: "先指出常见错误做法，再给更稳的流程", focus: "误区、正确做法、示例指令" },
  { key: "before-after", name: "前后对比型", angle: "展示处理前后的变化，用结果建立可信度", focus: "处理前、执行中、处理后" },
  { key: "one-person-team", name: "一人团队型", angle: "从一个人或小团队的重复劳动切入", focus: "个人卡点、任务拆分、交付结果" },
  { key: "calm-note", name: "冷静备忘型", angle: "像公开备忘录一样冷静总结，不喊口号", focus: "结论、清单、边界、复用提醒" },
  { key: "time-save", name: "时间收益型", angle: "从可感知的时间差切入，说明省时来自哪一步", focus: "原来耗时、关键动作、时间变化、使用边界" },
  { key: "combo-wow", name: "组合王炸型", angle: "讲两个工具为什么要分工组合，而不是孤立宣传", focus: "工具A职责、主产品职责、衔接动作、适合场景" },
  { key: "anti-chat", name: "反聊天框型", angle: "从“不要只让AI回答”切入，强调执行和交付", focus: "旧用法、新用法、执行证据、可复用句式" },
  { key: "starter-guide", name: "新手教程型", angle: "降低门槛，讲第一次上手应该怎么试", focus: "准备材料、第一句指令、结果检查、避坑" },
  { key: "question-talk", name: "话题提问型", angle: "用真实疑问制造讨论，再用案例回答", focus: "问题、案例、结论、边界" },
  { key: "collection", name: "收藏合集型", angle: "把内容做成可保存的指令/流程合集", focus: "可收藏场景、任务类型、复制句式、保存价值" },
  { key: "proof-shot", name: "证据截图型", angle: "用结果截图/输出物建立可信度", focus: "输入材料、执行中证据、输出结果、复核方法" }
];

function variantHash(str = "") {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function batchVariantFor({ acc, batch, globalIndex = 0, itemIndex = 1, itemTotal = 1 }) {
  const offset = variantHash(`${batch?.id || ""}:${acc?.id || acc?.name || ""}:${itemIndex}`);
  const base = BATCH_CREATIVE_VARIANTS[(globalIndex + (offset % 5)) % BATCH_CREATIVE_VARIANTS.length];
  const accTag = tagsOf(acc)[0] || groupOf(acc);
  const repeated = itemTotal > 1 ? `同账号第 ${itemIndex}/${itemTotal} 条也要换例子和标题，不要复用上一条。` : "";
  return {
    ...base,
    index: globalIndex + 1,
    total: Math.max(1, batch?.plannedTotal || batch?.productionIds?.length || 1),
    accountName: acc?.name || "",
    accountTag: accTag,
    focus: `${base.focus}；结合账号标签「${accTag}」写不同例子。${repeated}`
  };
}

function existingBatchCopies(batch, currentId) {
  return batchProds(batch)
    .filter(x => x.id !== currentId && (x.artifacts?.copy?.title || x.artifacts?.copy?.body))
    .map(x => ({ title: x.artifacts.copy.title || x.title || "", copy: x.artifacts.copy.body || "" }));
}

function existingBatchTopics(batch, currentId) {
  return batchProds(batch)
    .filter(x => x.id !== currentId && (x.topic || x.artifacts?.script?.title))
    .map(x => x.topic || x.artifacts.script.title || "")
    .filter(Boolean);
}

/* ---------- 会话 ---------- */
export function ensureSession() {
  let s = state.sessions.find(x => x.id === state.ui.activeSessionId);
  if (!s) s = state.sessions[0];
  if (!s || !ownedBy(s)) s = mySessions()[0] || newSession();
  state.ui.activeSessionId = s.id;
  return s;
}
/* 当前成员名下的会话（每人会话隔离，聊天记录不共享） */
export function mySessions() {
  return state.sessions.filter(ownedBy);
}
export function newSession() {
  // 已有空会话则复用，避免堆积
  const empty = mySessions().find(s => !(s.messages || []).length);
  if (empty) {
    state.ui.activeSessionId = empty.id;
    save("meta");
    emit("agent:session");
    return empty;
  }
  const s = { id: uid(), ownerId: state.ui.currentMemberId || null, title: "新会话", createdAt: Date.now(), messages: [] };
  state.sessions.unshift(s);
  state.ui.activeSessionId = s.id;
  save("sessions", "meta");
  emit("agent:session");
  return s;
}
export function renameSession(id, title) {
  const s = state.sessions.find(x => x.id === id);
  if (s && title) { s.title = title.slice(0, 24); save("sessions"); emit("agent:session"); }
}
export function deleteSession(id) {
  state.sessions = state.sessions.filter(x => x.id !== id);
  if (state.ui.activeSessionId === id) state.ui.activeSessionId = state.sessions[0]?.id || null;
  save("sessions", "meta");
  emit("agent:session");
}
/* 启动清理：历史遗留的空会话只保留最新一个 */
export function pruneEmptySessions() {
  const empties = state.sessions.filter(s => !(s.messages || []).length);
  if (empties.length > 1) {
    const keep = empties[0].id;
    state.sessions = state.sessions.filter(s => (s.messages || []).length || s.id === keep);
    if (!state.sessions.find(s => s.id === state.ui.activeSessionId)) state.ui.activeSessionId = state.sessions[0]?.id || null;
    save("sessions", "meta");
  }
}
/* 某会话下的批次（任务看板按会话独立） */
export function sessionBatches(sessionId) {
  return state.batches.filter(b => b.sessionId === sessionId);
}
/* 删除整批（连同未交付的在制产物与其 job） */
export function deleteBatch(batchId) {
  const b = batchById(batchId); if (!b) return;
  const ids = b.productionIds || [];
  const removedProdIds = state.productions.filter(p => ids.includes(p.id) && p.stage !== "delivered").map(p => p.id);
  const removedJobIds = state.jobs.filter(j => removedProdIds.includes(j.productionId)).map(j => j.id);
  state.productions = state.productions.filter(p => !(ids.includes(p.id) && p.stage !== "delivered"));
  state.jobs = state.jobs.filter(j => !ids.includes(j.productionId) || state.productions.some(p => p.id === j.productionId));
  state.batches = state.batches.filter(x => x.id !== batchId);
  save("productions", "jobs", "batches");
  removeRemote("batches", batchId);
  removeRemote("productions", ...removedProdIds);
  removeRemote("jobs", ...removedJobIds);
  emit("batch:update", b);
}
/* 从批次里删除单条任务 */
export function removeProductionFromBatch(pid) {
  const p = productionById(pid);
  const jobIds = state.jobs.filter(j => j.productionId === pid).map(j => j.id);
  state.productions = state.productions.filter(x => x.id !== pid);
  state.jobs = state.jobs.filter(j => j.productionId !== pid);
  state.batches.forEach(b => { b.productionIds = (b.productionIds || []).filter(id => id !== pid); });
  save("productions", "jobs", "batches");
  removeRemote("productions", pid);
  removeRemote("jobs", ...jobIds);
  if (p) emit("production:update", p);
}
export function addMsg(session, msg) {
  const m = { id: uid(), ts: Date.now(), ...msg };
  session.messages.push(m);
  if (session.title === "新会话" && msg.role === "user" && msg.type === "text") {
    session.title = (msg.payload.text || "").slice(0, 18) || "新会话";
  }
  save("sessions");
  emit("agent:msg", m);
  return m;
}
export function agentSay(text, extra = {}) {
  return addMsg(ensureSession(), { role: "agent", type: "text", payload: { text }, ...extra });
}

/* ---------- 批次 ---------- */
export function createBatch(plan, sessionId) {
  const sharedRefAssetIds = [...new Set([
    ...(Array.isArray(plan.sharedRefAssetIds) ? plan.sharedRefAssetIds : []),
    plan.sharedRefAssetId
  ].filter(Boolean))];
  const batch = {
    id: uid(), sessionId,
    planMessageId: plan.planMessageId || "",
    ownerId: state.ui.currentMemberId || null,
    goal: plan.goal || "",
    topic: (plan.content || "").trim() || (plan.topic || "").trim() || "自动随机创作",
    topicMode: (plan.content || "").trim() ? "fixed" : (plan.topicMode || "random"),   // fixed | random（每条内容自动出题）
    productId: plan.productId || "dumate",
    content: plan.content || "",
    accountProductIds: plan.accountProductIds || {},
    accountContents: plan.accountContents || {},
    accountCounts: plan.accountCounts || {},
    accountImageCounts: plan.accountImageCounts || {},
    useOnlineTrends: !!plan.useOnlineTrends,
    imageCount: Math.max(3, Math.min(12, Number(plan.imageCount || DEFAULT_XHS_IMAGE_COUNT) || DEFAULT_XHS_IMAGE_COUNT)),
    style: plan.style || "",
    accountCount: Number(plan.accountCount || plan.count) || null,
    perAccountCount: Math.max(1, Math.min(12, Number(plan.perAccountCount || 1) || 1)),
    sharedRefAssetId: sharedRefAssetIds[0] || null,  // 兼容旧字段
    sharedRefAssetIds,                               // 批量统一参考图（所有账号共用 logo/产品界面，可多张）
    accountRefAssetIds: plan.accountRefAssetIds || {},// 单账号定制参考图
    tags: plan.tags || [], group: plan.group || "all",
    accountIds: plan.accountIds || [],
    productionIds: [],
    phase: "drafting",         // drafting | awaiting_input | generating | review | done
    autoAdvance: state.ui.autoAdvance !== false,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  state.batches.push(batch);
  save("batches");
  return batch;
}

/* 固定流程模板：一键发起规定动作（主题每号随机、风格用账号自带创作风格） */
export const FLOW_TEMPLATES = {
  notes: { label: "全部图文号 · 出一批笔记", group: "图文组", icon: "image", desc: "每号随机主题 · 风格用账号自带 · 站内自动出图" },
  material: { label: "全部素材号 · 全自动出片", group: "素材", icon: "layers", desc: "随机主题 → 口播音频 → 逐镜头视频 → 智能混剪，无需人工上传" },
  dh: { label: "全部真人号 · 出口播视频", group: "真人", icon: "user", desc: "每号随机主题 · 分镜工坊分段生成 · 自动混剪" }
};
export function templatePlan(key) {
  const t = FLOW_TEMPLATES[key];
  if (!t) return null;
  const matched = selectAccountsForPlan({ tags: [], group: t.group, accountCount: 3, sort: "stale" });
  return {
    goal: t.label, topicMode: "random", topic: "", productId: "dumate", content: "", style: "",
    tags: [], group: t.group, sort: "stale", accountCount: 3, perAccountCount: 1,
    accountIds: matched.map(a => a.id), template: key,
    accountCounts: {},
    useOnlineTrends: false,
    sharedRefAssetIds: [], accountRefAssetIds: {}
  };
}
export const batchById = id => state.batches.find(b => b.id === id);
export const batchProds = b => (b.productionIds || []).map(productionById).filter(Boolean);
export const activeBatches = () => state.batches.filter(b => b.phase !== "done" && ownedBy(b));
/* 当前会话的批次（看板按会话独立） */
export const currentSessionBatches = () => sessionBatches(state.ui.activeSessionId)
  .filter(ownedBy)
  .filter(b => (b.productionIds || []).length);

function accountLastActivityAt(acc) {
  const prodTimes = state.productions
    .filter(p => p.accountId === acc.id)
    .map(p => p.deliveredAt || p.updatedAt || p.createdAt || 0);
  const assetTimes = state.assets
    .filter(a => a.accountId === acc.id && a.delivered)
    .map(a => a.publishedAt || a.updatedAt || a.createdAt || 0);
  return Math.max(acc.lastPublishedAt || 0, acc.updatedAt || 0, acc.createdAt || 0, ...prodTimes, ...assetTimes);
}

export function matchAccounts({ tags = [], group = "all", sort = "" } = {}) {
  const list = state.accounts.filter(a =>
    (group === "all" || !group || groupOf(a) === group) &&
    (!tags.length || tags.some(t => tagsOf(a).includes(t))));
  if (sort === "stale") {
    list.sort((a, b) => accountLastActivityAt(a) - accountLastActivityAt(b) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN"));
  }
  return list;
}

export function selectAccountsForPlan(params = {}) {
  const matched = matchAccounts(params);
  const want = Number(params.accountCount || params.count);
  if (want > 0 && want < matched.length) {
    if (params.pickFrom === "end") return matched.slice(-want);
    return matched.slice(0, want);
  }
  return matched;
}

export function defaultPlan(goal = "新量产计划") {
  const fb = parseGoalFallback(goal);
  const params = {
    ...fb,
    group: fb.group && fb.group !== "all" ? fb.group : "all",
    sort: fb.sort || "stale",
    accountCount: fb.accountCount || fb.count || null,
    perAccountCount: fb.perAccountCount || 1
  };
  return {
    status: "pending", goal,
    topicMode: "random", topic: "",
    productId: "dumate", content: "",
    accountProductIds: {}, accountContents: {},
    accountCounts: {},
    accountImageCounts: {},
    useOnlineTrends: false,
    imageCount: DEFAULT_XHS_IMAGE_COUNT,
    style: params.style || "", tags: params.tags || [], group: params.group,
    sort: params.sort,
    pickFrom: params.pickFrom || "",
    accountCount: params.accountCount,
    perAccountCount: params.perAccountCount,
    accountIds: [],
    sharedRefAssetIds: [], accountRefAssetIds: {}
  };
}

function hashSeed(str = "") {
  let h = 2166136261;
  for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
async function polishImageDataUrl(dataUrl, seedText = "") {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (!w || !h) return resolve(dataUrl);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      const rnd = seeded(hashSeed(seedText + ":" + w + "x" + h));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, w, h);
      ctx.filter = "saturate(1.055) contrast(1.045) brightness(1.018)";
      ctx.drawImage(img, 0, 0, w, h);
      ctx.filter = "none";
      const glow = ctx.createLinearGradient(0, 0, w, h);
      glow.addColorStop(0, "rgba(255,255,255,.10)");
      glow.addColorStop(1, "rgba(40,88,220,.035)");
      ctx.globalCompositeOperation = "soft-light";
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      const pad = Math.max(18, Math.round(Math.min(w, h) * 0.025));
      const len = Math.max(34, Math.round(Math.min(w, h) * (0.04 + rnd() * 0.025)));
      const colors = ["rgba(63,107,255,.22)", "rgba(255,77,141,.18)", "rgba(20,184,166,.18)", "rgba(154,69,255,.18)"];
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(3, Math.round(Math.min(w, h) * 0.004));
      const corners = [["tl", pad, pad, 1, 1], ["tr", w - pad, pad, -1, 1], ["bl", pad, h - pad, 1, -1], ["br", w - pad, h - pad, -1, -1]]
        .map((corner, i) => ({ corner, i, order: rnd() }))
        .sort((a, b) => a.order - b.order)
        .slice(0, Math.floor(rnd() * 3)); // 0-2 个角，避免每张图四角都出现括号。
      corners.forEach(({ corner: c, i }) => {
        const [, x, y, sx, sy] = c;
        ctx.strokeStyle = colors[(i + Math.floor(rnd() * colors.length)) % colors.length];
        ctx.globalAlpha = 0.72 + rnd() * 0.18;
        ctx.beginPath();
        const variant = Math.floor(rnd() * 4);
        if (variant === 0) {
          ctx.moveTo(x, y + sy * len);
          ctx.quadraticCurveTo(x, y, x + sx * len, y);
        } else if (variant === 1) {
          ctx.moveTo(x, y + sy * len * 0.9);
          ctx.lineTo(x, y + sy * len * 0.25);
          ctx.moveTo(x + sx * len * 0.25, y);
          ctx.lineTo(x + sx * len * 0.9, y);
        } else if (variant === 2) {
          const r = len * 0.22;
          ctx.arc(x + sx * r, y + sy * r, r, 0, Math.PI * 2);
        } else {
          ctx.moveTo(x, y + sy * len * 0.55);
          ctx.lineTo(x + sx * len * 0.55, y);
          ctx.moveTo(x + sx * len * 0.18, y + sy * len * 0.72);
          ctx.lineTo(x + sx * len * 0.72, y + sy * len * 0.18);
        }
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
      resolve(canvas.toDataURL(dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg", 0.94));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function dataUrlFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("图片 URL 下载失败：" + res.status);
  return await fileToDataUrl(await res.blob());
}

function imageRefGroupsFor(acc, batch, p) {
  const A = p.artifacts.images || {};
  const uniq = arr => [...new Set(arr.filter(Boolean))];
  const shared = uniq([
    ...(Array.isArray(batch.sharedRefAssetIds) ? batch.sharedRefAssetIds : []),
    batch.sharedRefAssetId
  ]);
  const customRaw = batch.accountRefAssetIds?.[acc.id];
  const custom = uniq(Array.isArray(customRaw) ? customRaw : [customRaw]);
  const sharedIds = uniq([
    ...shared,
    ...(Array.isArray(A.sharedRefAssetIds) ? A.sharedRefAssetIds : []),
    A.sharedRefAssetId,
    acc.imageStyleAssetId,
    ...accountDefaultRefIds(acc)
  ]).slice(0, 5);
  const customIds = custom.slice(0, 3);
  return {
    shared: sharedIds,
    custom: customIds,
    all: uniq([...sharedIds, ...customIds]).slice(0, 8)
  };
}

async function imageRefsForIds(ids, role = "shared") {
  const refs = [];
  for (const id of ids) {
    const a = state.assets.find(x => x.id === id);
    if (!a) continue;
    const blob = await assetBlob(id);
    const u = urlFor(a);
    let dataUrl = "";
    let publicUrl = "";
    if (blob) dataUrl = await fileToDataUrl(blob);
    else if (/^data:/.test(u || "")) dataUrl = u;
    else if (/^https?:\/\//.test(u || "")) publicUrl = u;
    else if (u) {
      try { dataUrl = await dataUrlFromUrl(u); } catch (_) { /* ignore */ }
    }
    if (dataUrl || publicUrl) {
      refs.push({ id, role, name: a.name || "参考图", type: a.type, mime: a.mime || blob?.type || "image/png", url: publicUrl, dataUrl });
    }
  }
  return refs;
}

function enrichBatchImagePrompt(prompt, refs) {
  if (!refs.length) return prompt || "";
  const shared = refs.filter(r => r.role !== "custom");
  const custom = refs.filter(r => r.role === "custom");
  const sharedNames = shared.map(r => r.name).filter(Boolean).slice(0, 5).join("、");
  const customNames = custom.map(r => r.name).filter(Boolean).slice(0, 3).join("、");
  const customNote = custom.length ? `\n定制参考图：另提供 ${custom.length} 张本账号专属参考图（${customNames}），优先承接其账号专属视觉、素材语气、画面结构或产品细节；统一参考图继续负责品牌一致性。` : "";
  const body = String(prompt || "").replace(/负面约束\s*[:：][\s\S]*$/g, "").trim();
  const refNote = `统一参考图：已提供 ${shared.length} 张统一参考图（${sharedNames}），生成时综合参考产品界面、配色、信息密度、真实截图质感和图标形态，按当前画面主题选择主参考与辅助参考。${customNote}\n参考图中的旧标题、页名和示例文案视为占位，画面文字按当前提示词重写。`;
  return `${body}\n\n${refNote}\n\n${IMAGE_NEGATIVE_PROMPT}`.trim();
}

async function generateBatchImagesInHouse(p, batch, acc) {
  if (!imageApiConfigured()) return false;
  const provider = activeProviderFor("image");
  if (!provider || provider.mock) return false;
  const key = providerKeyFor("image", provider);
  const A = p.artifacts.images;
  const refGroups = imageRefGroupsFor(acc, batch, p);
  A.usedSharedRefAssetIds = refGroups.shared;
  A.usedCustomRefAssetIds = refGroups.custom;
  A.usedRefAssetIds = refGroups.all;
  const refs = [
    ...(await imageRefsForIds(refGroups.shared, "shared")),
    ...(await imageRefsForIds(refGroups.custom, "custom"))
  ].slice(0, 8);
  const items = A.items || [];
  setStage(p, "images", "running");
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it?.prompt) continue;
    if (it.assetId && it.status === "done") continue;
    it.status = "loading";
    save("productions");
    const req = await provider.submit({
      prompt: enrichBatchImagePrompt(it.prompt, refs),
      refs,
      ratio: "3:4",
      apiKey: key?.secret,
      endpoint: key?.provider,
      model: key?.model || ""
    });
    const out = await provider.poll(req.providerRef);
    if (out.status !== "succeeded" || !out.output?.dataUrl) throw new Error(out.error || `第 ${i + 1} 张图片生成未返回结果`);
    const raw = out.output.dataUrl.startsWith("data:") ? out.output.dataUrl : await dataUrlFromUrl(out.output.dataUrl);
    const polished = await polishImageDataUrl(raw, `${p.id}-batch-${i}-${p.topic || ""}`);
    const a = await addAssetFromDataUrl(acc.id, {
      name: `站内笔记图${String(i + 1).padStart(2, "0")}_${(it.title || p.title || "").slice(0, 10)}`,
      tags: ["笔记图", "站内生成", "发布前精修"],
      dataUrl: polished
    });
    it.assetId = a.id;
    it.status = "done";
    save("productions");
  }
  return items.length > 0 && items.every(x => x.assetId);
}

async function runBatchImagesToReview(p, batch) {
  if (activeImageRecoveries.has(p.id)) return false;
  const acc = accountById(p.accountId);
  if (!acc) {
    setStatus(p, "failed", "账号不存在");
    return false;
  }
  activeImageRecoveries.add(p.id);
  try {
    setBatchPhase(batch, "generating");
    const generated = await generateBatchImagesInHouse(p, batch, acc);
    setStage(p, generated ? "review" : "images", generated ? "pending" : "needs_input");
    return generated;
  } catch (e) {
    setStatus(p, "failed", "站内图片生成失败：" + (e.message || e));
    return false;
  } finally {
    activeImageRecoveries.delete(p.id);
    evaluate(batch.id);
  }
}

/* ---------- 起草 ---------- */
async function draftOne(p, batch) {
  const acc = accountById(p.accountId);
  if (!acc) { setStatus(p, "failed", "账号不存在"); return; }
  const isImg = p.mode === "图文";
  const material = isMaterial(p);
  try {
    setStatus(p, "running");
    // 主题 / 创作内容：支持批次总内容，也支持账号独立覆盖；为空时每号按定位随机
    const rawProductId = (batch.accountProductIds && batch.accountProductIds[acc.id]) || batch.productId || p.artifacts.script.productId || "dumate";
    const productId = primaryProductById(rawProductId)?.id || "dumate";
    p.artifacts.script.productId = productId;
    const contentOverride = ((batch.accountContents && batch.accountContents[acc.id]) || batch.content || "").trim();
    let topic = contentOverride || (batch.topicMode === "random" ? "" : batch.topic);
    const product = productById(productId);
    const style = acc.styleProfile || acc.lockedStyle || batch.style || "";
    const useOnlineTrends = !!batch.useOnlineTrends;
    const batchVariant = p.batchCreativeVariant || p.artifacts.script.batchCreativeVariant || batchVariantFor({
      acc,
      batch,
      globalIndex: Math.max(0, (batch.productionIds || []).indexOf(p.id)),
      itemIndex: p.batchItemIndex || 1,
      itemTotal: p.batchItemTotal || 1
    });
    p.batchCreativeVariant = batchVariant;
    p.artifacts.script.batchCreativeVariant = batchVariant;
    let trendPrep = await AI.trendPrep({
      topic: contentOverride || batch.topic || p.topic || "",
      account: acc,
      product,
      batchVariant,
      useOnlineTrends,
      kind: isImg ? "image" : "video",
      imageCount: p.artifacts.script.imageCount || DEFAULT_XHS_IMAGE_COUNT,
      seed: `${batch.id}:${p.id}:${acc.id}:${p.batchItemIndex || 1}`
    });
    let trendGuide = trendPrep?.guide || "";
    if (!topic && trendPrep?.creativeContent) topic = trendPrep.creativeContent;
    if (!topic) topic = p.topic || await AI.randomPick({
      kind: "topic",
      account: acc,
      product,
      batchVariant,
      seed: `${batch.id}:${p.id}:${acc.id}:${p.batchItemIndex || 1}`,
      avoidTopics: existingBatchTopics(batch, p.id),
      useOnlineTrends,
      trendGuide,
      trendPrep
    });
    p.topic = topic;
    p.artifacts.script.trendPrep = trendPrep;
    p.artifacts.script.trendGuide = trendGuide;
    p.artifacts.script.useOnlineTrends = useOnlineTrends;

    const sres = material
      ? await AI.generateMaterialScript({ topic, account: acc, style, product })
      : await AI.generateScript({
        topic,
        duration: isImg ? 0 : 55, account: acc, image: isImg, style: isImg ? style : "",
        imageCount: p.artifacts.script.imageCount || DEFAULT_XHS_IMAGE_COUNT, product,
        direction: isImg ? topic : "",
        imageTemplate: acc.imagePromptTemplate || "",
        styleRefName: acc.imageStyleAssetId ? (state.assets.find(a => a.id === acc.imageStyleAssetId)?.name || "") : "",
        batchVariant: isImg ? batchVariant : null,
        useOnlineTrends,
        trendGuide,
        trendPrep
      });
    p.artifacts.script.shots = sres.shots || [];
    p.artifacts.script.title = sres.title || topic;
    p.artifacts.script.source = AI.lastSource;
    p.artifacts.script.style = style;
    p.title = sres.title || topic;

    if (isImg) {
      const cp = await AI.generateCopy({
        topic,
        shots: p.artifacts.script.shots,
        account: acc,
        style,
        kind: "image",
        product,
        batchVariant,
        avoidCopies: existingBatchCopies(batch, p.id),
        useOnlineTrends,
        trendGuide,
        trendPrep
      });
      p.artifacts.copy = { title: cp.title || p.title, body: cp.copy || "" };
      const imgPromptRes = await AI.generateImagePrompts({
        script: shotsToText(p.artifacts.script.shots, true),
        account: acc,
        style,
        imageTemplate: acc.imagePromptTemplate || "",
        imageCount: p.artifacts.script.imageCount || DEFAULT_XHS_IMAGE_COUNT,
        product,
        topic,
        styleRefName: acc.imageStyleAssetId ? (state.assets.find(a => a.id === acc.imageStyleAssetId)?.name || "") : "",
        batchVariant,
        useOnlineTrends,
        trendGuide,
        trendPrep,
        copy: p.artifacts.copy
      });
      const promptRows = imgPromptRes.shots || [];
      p.artifacts.images.items = p.artifacts.script.shots.map((s, i) => ({
        title: promptRows[i]?.title || `图片${i + 1}`,
        visual: s.visual || "",
        prompt: promptRows[i]?.prompt || "",
        assetId: null,
        status: "idle"
      }));
      p.artifacts.images.externalPrompt = buildImgExternalPrompt({
        topic, position: acc.position, shots: p.artifacts.script.shots, style,
        items: p.artifacts.images.items,
        template: acc.imagePromptTemplate || "",
        productName: promptProductName(product),
        imageCount: p.artifacts.script.imageCount || DEFAULT_XHS_IMAGE_COUNT,
        refNames: acc.imageStyleAssetId ? [state.assets.find(a => a.id === acc.imageStyleAssetId)?.name].filter(Boolean) : []
      });
    } else {
      // 视频号全自动：口播估时 → 按场景合并分镜单元 → 分段提示词 → 派发视频任务
      Object.assign(p.artifacts.audio, estimateAudio(p.artifacts.script.shots), { source: "estimate" });
      if (acc.voiceId && !p.artifacts.audio.voiceId) p.artifacts.audio.voiceId = acc.voiceId;
      if (acc.voiceRefAssetId && !p.artifacts.audio.voiceRefAssetId && !p.artifacts.audio.voiceRefDisabled) p.artifacts.audio.voiceRefAssetId = acc.voiceRefAssetId;
      // 批量统一参考图（所有账号共用 logo/产品界面）
      if (batch.sharedRefAssetId && accountAssetsHas(acc.id, batch.sharedRefAssetId)) p.artifacts.boards.sharedRefAssetId = batch.sharedRefAssetId;
      const units = buildMaterialUnits(p);
      const ures = await AI.generateUnitPrompts({
        units, shots: p.artifacts.script.shots, account: acc, style, product,
        hasNarrationAudio: false,
        hasVoiceRef: !!p.artifacts.audio.voiceRefAssetId,
        hasCharacterRef: !!acc?.charBoardAssetId,
        hasSceneRef: !!(batch.sharedRefAssetId || p.artifacts.boards.sharedRefAssetId)
      });
      units.forEach((u, i) => { u.imagePrompt = (ures.units[i] || {}).imagePrompt || ""; u.videoPrompt = (ures.units[i] || {}).videoPrompt || ""; });
      p.artifacts.boards.externalGroups = buildSbExternalGroups({ shots: p.artifacts.script.shots, style });
      const cp0 = await AI.generateCopy({ topic, shots: p.artifacts.script.shots, account: acc, style, kind: "video", product, batchVariant, avoidCopies: existingBatchCopies(batch, p.id), useOnlineTrends, trendGuide, trendPrep });
      p.artifacts.copy = { title: cp0.title || p.title, body: cp0.copy || "" };
      setStage(p, "workshop", "running");
      createUnitVideoJobs(p);   // t2v 单元直接生成；i2v 单元无图时也先出片占位，回工坊可补图重生成
      return;
    }
    if (!isImg) {
      const cp = await AI.generateCopy({ topic, shots: p.artifacts.script.shots, account: acc, style, kind: "video", product, batchVariant: null, avoidCopies: existingBatchCopies(batch, p.id), useOnlineTrends, trendGuide, trendPrep });
      p.artifacts.copy = { title: cp.title || p.title, body: cp.copy || "" };
    }
    if (isImg) {
      await runBatchImagesToReview(p, batch);
    } else {
      setStage(p, "boards", "needs_input");
    }
  } catch (e) {
    setStatus(p, "failed", "起草失败：" + (e.message || e));
  }
}

function accountAssetsHas(accId, assetId) {
  return state.assets.some(a => a.id === assetId && a.accountId === accId);
}

function accountDefaultRefIds(acc) {
  if (!acc) return [];
  const out = [];
  if (acc.charBoardAssetId) out.push(acc.charBoardAssetId);
  state.assets.forEach(a => {
    if (a.accountId !== acc.id || a.type !== "图片" || a.delivered) return;
    const text = `${a.name || ""} ${(a.tags || []).join(" ")}`;
    if (/全能参考|统一参考|角色|身份|logo|界面|产品/.test(text)) out.push(a.id);
  });
  return [...new Set(out)].slice(0, 5);
}

/* 素材号：按「分镜单元」派发视频任务（全能参考单元带固定 logo+界面图、文生视频单元纯文生；已成功的跳过） */
export function createUnitVideoJobs(p, onlyUnitIndex = null) {
  const units = buildMaterialUnits(p); // 重算确保与脚本同步
  const A = p.artifacts.boards;
  // 全能参考素材：固定 logo + 界面图（omniRefAssetIds），兼容批量流程设的 sharedRefAssetId
  const acc = accountById(p.accountId);
  A.omniRefAssetIds = A.omniRefAssetIds || [];
  A.sceneRefAssetIds = A.sceneRefAssetIds || [];
  if (!A.characterRefAssetId && acc?.charBoardAssetId) A.characterRefAssetId = acc.charBoardAssetId;
  if (!A.omniRefAssetIds.length) A.omniRefAssetIds = accountDefaultRefIds(acc);
  if (acc?.voiceRefAssetId && !p.artifacts.audio.voiceRefAssetId && !p.artifacts.audio.voiceRefDisabled) p.artifacts.audio.voiceRefAssetId = acc.voiceRefAssetId;
  const characterRefId = A.characterRefAssetId || acc?.charBoardAssetId || null;
  const sceneRefs = [...new Set([
    ...(A.sceneRefAssetIds || []),
    ...(A.omniRefAssetIds || []).filter(id => id !== characterRefId),
    A.sharedRefAssetId
  ].filter(Boolean))];
  const hasExternalVoice = !!p.artifacts.audio.assetId && ["tts", "upload"].includes(p.artifacts.audio.source);
  const wantsSeedanceVoice = !!(p.artifacts.audio.voiceRefAssetId || (!p.artifacts.audio.voiceRefDisabled && acc?.voiceRefAssetId));
  const voiceRefs = [
    p.artifacts.audio.voiceRefDisabled ? null : (p.artifacts.audio.voiceRefAssetId || acc?.voiceRefAssetId || null)
  ].filter(Boolean);
  const audioRefs = [...voiceRefs].filter(Boolean);
  let n = 0;
  units.forEach((u, i) => {
    if (onlyUnitIndex != null && i !== onlyUnitIndex) return;
    if (!u.videoPrompt) return;
    if (onlyUnitIndex == null && state.jobs.some(j => j.productionId === p.id && j.segIndex === i && j.status === "succeeded" && j.prompt === u.videoPrompt)) return;
    // 真人只在第一段带角色参考；场景/产品参考按需要挂载，避免角色图污染纯场景片段。
    const needsCharacter = p.subType === "数字人" && i === 0;
    const refs = [...new Set([
      needsCharacter ? characterRefId : null,
      ...(u.needsImage || needsCharacter ? sceneRefs : []),
      ...audioRefs
    ].filter(Boolean))].slice(0, 9);
    createJob({
      kind: "video", productionId: p.id, segIndex: i,
      segName: `场景${String(u.scene).padStart(2, "0")}${u.shotIndexes.length > 1 ? `·${u.shotIndexes.length}镜` : ""}`,
      prompt: u.videoPrompt, refAssetIds: refs,
      ratio: A.ratio || "9:16",
      duration: Math.min(15, Math.max(2, Math.ceil(u.dur || 4))),
      generateAudio: wantsSeedanceVoice || !hasExternalVoice
    });
    n++;
  });
  return n;
}
/* 兼容旧调用名 */
export const createShotVideoJobs = createUnitVideoJobs;

function setBatchPhase(batch, phase) {
  if (!batch || batch.phase === phase) return;
  batch.phase = phase;
  batch.updatedAt = Date.now();
  save("batches");
  emit("batch:update", batch);
}

export async function startBatch(plan, session) {
  const accounts = plan.accountIds.map(accountById).filter(Boolean);
  if (!accounts.length) { agentSay("⚠ 没有可用账号，先调整筛选条件。"); return null; }
  const batch = createBatch(plan, session.id);
  const defaultPerAccountCount = Math.max(1, Math.min(12, Number(plan.perAccountCount || 1) || 1));
  const defaultImageCount = Math.max(3, Math.min(12, Number(plan.imageCount || DEFAULT_XHS_IMAGE_COUNT) || DEFAULT_XHS_IMAGE_COUNT));
  batch.plannedTotal = accounts.reduce((sum, acc) => {
    const n = Math.max(1, Math.min(12, Number((plan.accountCounts || {})[acc.id] || defaultPerAccountCount) || defaultPerAccountCount));
    return sum + n;
  }, 0);
  accounts.forEach(acc => {
    const rawProductId = (plan.accountProductIds || {})[acc.id] || plan.productId || "dumate";
    const productId = primaryProductById(rawProductId)?.id || "dumate";
    const perAccountCount = Math.max(1, Math.min(12, Number((plan.accountCounts || {})[acc.id] || defaultPerAccountCount) || defaultPerAccountCount));
    const imageCount = Math.max(3, Math.min(12, Number((plan.accountImageCounts || {})[acc.id] || defaultImageCount) || defaultImageCount));
    for (let i = 0; i < perAccountCount; i++) {
      const globalIndex = batch.productionIds.length;
      const topic = plan.topicMode === "random" ? "" : (perAccountCount > 1 ? `${plan.topic} ${i + 1}/${perAccountCount}` : plan.topic);
      const p = createProduction({ accountId: acc.id, topic, origin: "agent", batchId: batch.id, style: plan.style, productId });
      if (p) {
        p.artifacts.script.imageCount = imageCount;
        p.batchItemIndex = i + 1;
        p.batchItemTotal = perAccountCount;
        p.batchCreativeVariant = batchVariantFor({ acc, batch, globalIndex, itemIndex: i + 1, itemTotal: perAccountCount });
        p.artifacts.script.batchCreativeVariant = p.batchCreativeVariant;
        batch.productionIds.push(p.id);
      }
    }
  });
  save("batches", "productions");
  emit("batch:update", batch);
  addMsg(session, { role: "agent", type: "progress", payload: { batchId: batch.id } });
  notify("agent", `批次启动：「${batch.topic}」`, `${accounts.length} 个账号 · 共 ${batch.productionIds.length} 条内容`);
  // 起草过程播报到思考面板
  emit("agent:thinking", { sessionId: session.id, value: true });
  think(`并发起草 ${accounts.length} 个账号 · ${batch.productionIds.length} 条内容…`, session.id);
  let drafted = 0;
  const total = batch.productionIds.length;
  runPool(batchProds(batch), async p => {
    await draftOne(p, batch);
    drafted++;
    think(`起草完成 ${drafted}/${total} · ${accountById(p.accountId)?.name || ""}`, session.id);
  }, 2).then(() => {
    emit("agent:thinking", { sessionId: session.id, value: false });
    evaluate(batch.id);
  }).catch(err => {
    console.error(err);
    batch.phase = "review";
    batch.error = String(err?.message || err || "批量任务启动失败");
    batch.updatedAt = Date.now();
    save("batches");
    think("批量任务启动失败，请检查本地 API 或稍后重试", session.id);
    emit("agent:thinking", { sessionId: session.id, value: false });
    emit("batch:update", batch);
  });
  return batch;
}

/* ---------- 上传完成后的推进 ---------- */
export function maybeAdvanceAfterInput(p) {
  const isImg = p.mode === "图文";
  const items = isImg ? p.artifacts.images.items : p.artifacts.boards.items;
  if (!items.length || !items.every(x => x.assetId)) return false;
  if (isImg) {
    // 图文：文案已合并到图文创作台；文案缺失时留在本页补齐。
    setStage(p, (p.artifacts.copy.body || "").trim() ? "review" : "images", "pending");
  } else {
    // 视频：分镜齐 → 渲染就绪
    setStage(p, "render", "pending");
  }
  return true;
}

/* ---------- 渲染 ---------- */
export function startGeneration(batch) {
  let jobs = 0;
  batchProds(batch).forEach(p => {
    if (isVideoWorkshop(p) && p.stage === "workshop") {
      if (p.stage === "workshop" && p.stageStatus !== "running") {
        const n = createUnitVideoJobs(p);
        if (n) { setStatus(p, "running"); jobs += n; }
      }
      return;
    }
  });
  if (jobs) {
    batch.phase = "generating"; batch.updatedAt = Date.now();
    save("batches");
    emit("batch:update", batch);
  }
  return jobs;
}

/* ---------- 审核 / 交付 ---------- */
export function approveAll(batch) {
  let n = 0;
  batchProds(batch).forEach(p => {
    if (p.stage === "review" && p.review.state !== "approved") { p.review.state = "approved"; p.review.at = Date.now(); n++; }
  });
  save("productions");
  emit("batch:update", batch);
  return n;
}
export function deliverAll(batch, opts = {}) {
  let n = 0;
  batchProds(batch).forEach(p => {
    if (p.stage === "review") { if (deliver(p, opts)) n++; }   // deliver 自带定稿，无需先 approve
  });
  evaluate(batch.id);
  return n;
}
export function retryFailedIn(batch) {
  let n = 0;
  batchProds(batch).forEach(p => {
    const jobStage = p.stage === "render" || p.stage === "workshop";
    if (p.stageStatus !== "failed") {
      // 渲染/工坊中的失败 job 也重试
      if (jobStage) jobsOf(p).filter(j => j.status === "failed").forEach(j => { retryJob(j.id); setStatus(p, "running"); n++; });
      return;
    }
    if (p.stage === "script") { setStatus(p, "pending"); draftOne(p, batch).then(() => evaluate(batch.id)); n++; }
    else if (p.mode === "图文" && (p.stage === "images" || p.artifacts?.images?.items?.length)) {
      runBatchImagesToReview(p, batch);
      n++;
    }
    else if (jobStage) {
      const failed = jobsOf(p).filter(j => j.status === "failed");
      if (failed.length) failed.forEach(j => retryJob(j.id));
      else if (p.stage === "workshop") createUnitVideoJobs(p);
      setStatus(p, "running"); n++;
    } else { setStatus(p, "pending"); n++; }
  });
  if (n && batch.phase === "review") { batch.phase = "generating"; save("batches"); }
  return n;
}

/* ---------- 阶段评估（事件驱动核心） ---------- */
export function evaluate(batchId) {
  const batch = batchById(batchId);
  if (!batch || batch.phase === "done") return;
  const prods = batchProds(batch);
  if (!prods.length) return;
  const session = state.sessions.find(s => s.id === batch.sessionId) || ensureSession();

  // 老批次（改动前创建、无 emitted 标记）：用会话里已存在的卡片回填，避免刷新后重复发卡
  if (!batch.emitted) {
    batch.emitted = {};
    const msgs = session.messages || [];
    const has = (type, pred) => msgs.some(x => x.type === type && x.payload?.batchId === batch.id && (pred ? pred(x) : true));
    if (has("need_input", x => x.payload?.mode !== "confirm_generate")) batch.emitted.awaiting_input = true;
    if (has("need_input", x => x.payload?.mode === "confirm_generate")) batch.emitted.gen_wait = true;
    if (has("approval")) batch.emitted.review = true;
    if (has("results")) batch.emitted.done = true;
    if (has("error")) batch.emitted.allfail = true;
    // gen_kick 是纯文本无法精确回填：只要有任务已过/在渲染阶段，就认为已发过
    if (prods.some(p => ["render", "workshop", "cut", "copy", "review", "delivered"].includes(p.stage))) batch.emitted.gen_kick = true;
  }

  const drafting = prods.filter(p => p.stage === "script" && p.stageStatus !== "failed").length;
  const failed = prods.filter(p => p.stageStatus === "failed").length;
  const waiting = prods.filter(p => p.stageStatus === "needs_input").length;
  const imageGenerating = prods.filter(p => p.stage === "images" && p.stageStatus === "running").length;
  const renderPending = prods.filter(p =>
    (p.mode === "视频" && p.stage === "render" && p.stageStatus !== "running") ||
    (p.stage === "workshop" && p.stageStatus !== "running")).length;
  const rendering = prods.filter(p => (p.stage === "render" || p.stage === "workshop") && p.stageStatus === "running");
  const inReview = prods.filter(p => p.stage === "review").length;
  const delivered = prods.filter(p => p.stage === "delivered").length;

  // 渲染完成检测：所有 job 成功 → 智能剪辑 → 进审核
  rendering.forEach(p => {
    const jobs = jobsOf(p);
    if (!jobs.length) return;
    const allOk = jobs.every(j => j.status === "succeeded");
    const anyFail = jobs.some(j => j.status === "failed");
    const active = jobs.some(j => ["queued", "submitted", "running"].includes(j.status));
    if (allOk) {
      const r = autoAssemble(p);
      setStage(p, "review", "pending");
      notify("agent", `「${p.title || p.topic}」渲染完成`, `已智能${isVideoWorkshop(p) ? "混剪" : "拼接"} ${r.clips} 段 + ${r.subs} 条字幕${r.bgm ? ` · BGM「${r.bgm}」` : ""}，进入待审核`);
    } else if (anyFail && !active) {
      setStatus(p, "failed", jobs.find(j => j.status === "failed")?.error || "部分片段生成失败");
    }
  });

  // 已发卡片/消息去重：持久化在 batch 上，刷新或状态震荡都不会重复发同一条
  const emitOnce = (ph, fn) => { batch.emitted = batch.emitted || {}; if (!batch.emitted[ph]) { batch.emitted[ph] = true; fn(); } };

  if (imageGenerating > 0) { batch.phase = "generating"; }
  else if (drafting > 0) { batch.phase = "drafting"; }
  else if (waiting > 0) {
    batch.phase = "awaiting_input";
    emitOnce("awaiting_input", () => {
      addMsg(session, { role: "agent", type: "need_input", payload: { batchId: batch.id } });
    });
  } else if (renderPending > 0 || rendering.length > 0) {
    if (renderPending > 0 && batch.autoAdvance) {
      // 素材号用站内分镜（无需上传）；真人号用站外分镜上传后渲染——措辞区分
      const pend = prods.filter(p => (p.mode === "视频" && p.stage === "render" && p.stageStatus !== "running") || (p.stage === "workshop" && p.stageStatus !== "running"));
      const allInhouse = pend.length > 0 && pend.every(p => p.stage === "workshop");
      emitOnce("gen_kick", () => agentSay(allInhouse
        ? "脚本就绪，自动开始批量生成分镜视频（站内分镜 · 并发 2，其余排队）。"
        : "分镜全部上传完成，自动开始批量渲染（并发 2，其余排队）。"));
      startGeneration(batch);
    } else if (renderPending > 0 && !batch.autoAdvance) {
      batch.phase = "awaiting_input";
      emitOnce("gen_wait", () => {
        addMsg(session, { role: "agent", type: "need_input", payload: { batchId: batch.id, mode: "confirm_generate" } });
      });
    } else {
      batch.phase = "generating";
    }
  } else if (inReview > 0 || (failed > 0 && delivered + inReview > 0)) {
    batch.phase = "review";
    emitOnce("review", () => {
      addMsg(session, { role: "agent", type: "approval", payload: { batchId: batch.id } });
      notify("review", `批次「${batch.topic}」待审核`, `${inReview} 条内容等待人工确认`);
    });
  } else if (delivered === prods.length && prods.length > 0) {
    batch.phase = "done";
    emitOnce("done", () => {
      addMsg(session, { role: "agent", type: "results", payload: { batchId: batch.id } });
      notify("agent", `批次「${batch.topic}」全部交付完成`, `${delivered} 条内容已入库`);
    });
  } else if (failed === prods.length) {
    batch.phase = "review";
    emitOnce("allfail", () => addMsg(session, { role: "agent", type: "error", payload: { batchId: batch.id } }));
  }
  batch.updatedAt = Date.now();
  save("batches");
  emit("batch:update", batch);
}

const evaluateAll = debounce(() => activeBatches().forEach(b => evaluate(b.id)), 250);
on("production:update", evaluateAll);
on("job:done", evaluateAll);

/* 启动恢复：把中断的起草接着跑 */
export function resumeActiveBatches() {
  let resumed = 0;
  activeBatches().forEach(b => {
    const stuck = batchProds(b).filter(p => p.stage === "script" && (p.stageStatus === "running" || p.stageStatus === "pending"));
    if (stuck.length) { runPool(stuck, p => draftOne(p, b), 2).then(() => evaluate(b.id)); resumed += stuck.length; }
    const imageStuck = batchProds(b).filter(p =>
      p.mode === "图文"
      && p.stage === "images"
      && (p.stageStatus === "running" || p.stageStatus === "pending")
      && (p.artifacts?.images?.items || []).some(x => x.prompt && !x.assetId)
    );
    if (imageStuck.length) {
      runPool(imageStuck, p => runBatchImagesToReview(p, b), 1).then(() => evaluate(b.id));
      resumed += imageStuck.length;
    }
    evaluate(b.id);
  });
  return resumed;
}

/* ---------- 媒体路由：对话区拖图 → 顺序分发到等待上传的任务 ---------- */
export async function routeMediaFiles(files, batchId = null) {
  const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
  const vids = Array.from(files).filter(f => f.type.startsWith("video/"));
  const out = { assigned: 0, tasks: 0, extra: 0, videos: vids.length };
  if (imgs.length) {
    const hasGap = p => ((p.mode === "图文" ? p.artifacts.images.items : p.artifacts.boards.items) || []).some(x => !x.assetId);
    // 从某个批次的上传区拖入 → 只分发到该批次的任务，且按看板/卡片显示顺序填，避免跑到别的账号/会话上
    const b = batchId ? batchById(batchId) : null;
    const targets = b
      ? batchProds(b).filter(p => p.stageStatus === "needs_input" && hasGap(p))
      : state.productions.filter(p => p.stageStatus === "needs_input" && hasGap(p)).sort((a, b2) => a.createdAt - b2.createdAt);
    let fi = 0;
    for (const p of targets) {
      if (fi >= imgs.length) break;
      const isImg = p.mode === "图文";
      const items = isImg ? p.artifacts.images.items : p.artifacts.boards.items;
      let took = 0;
      for (const item of items) {
        if (fi >= imgs.length) break;
        if (item.assetId) continue;
        const rawDataUrl = await fileToDataUrl(imgs[fi++]);
        const dataUrl = isImg ? await polishImageDataUrl(rawDataUrl, `${p.id}-agent-upload-${items.indexOf(item)}-${p.topic || ""}`) : rawDataUrl;
        const a = await addAssetFromDataUrl(p.accountId, {
          name: `${isImg ? "笔记图" : "分镜图"}${String(items.indexOf(item) + 1).padStart(2, "0")}_${(p.title || "").slice(0, 6)}`,
          tags: [isImg ? "笔记图" : "分镜图", "Agent上传", ...(isImg ? ["发布前精修"] : [])], dataUrl
        });
        item.assetId = a.id; item.status = "done";
        took++; out.assigned++;
      }
      if (took) {
        out.tasks++;
        if (items.every(x => x.assetId)) maybeAdvanceAfterInput(p);
        else save("productions");
      }
    }
    out.extra = imgs.length - fi;
  }
  for (const f of vids) {
    const accId = state.productions.find(p => p.batchId)?.accountId || state.accounts[0]?.id;
    if (accId) await addAssetFromFile(accId, f, { tags: ["Agent上传"] });
  }
  evaluateAll();
  return out;
}

/* ---------- 用户输入主入口 ---------- */
export function contextSummary() {
  const bs = activeBatches();
  if (!bs.length) return "无进行中的批次";
  return bs.map(b => {
    const prods = batchProds(b);
    const c = {};
    prods.forEach(p => { const k = p.stage + (p.stageStatus === "failed" ? "(失败)" : ""); c[k] = (c[k] || 0) + 1; });
    return `批次「${b.topic}」阶段:${b.phase}，任务:${Object.entries(c).map(([k, v]) => k + "×" + v).join("、")}`;
  }).join("；");
}

/* 思考过程播报（驱动对话区的思考小面板） */
export function think(step, sessionId = state.ui.activeSessionId) { emit("agent:think", { sessionId, step }); }
const INTENT_LABEL = { plan_batch: "拆解量产计划", run_generation: "派发生成任务", approve_all: "批量过审", deliver_all: "批量交付", retry_failed: "重试失败项", status_query: "汇总当前进度" };

function isPureAccountSelection(text) {
  const s = text.trim();
  if (/[「"]/.test(s) || /主题|关于|围绕|做一?期|出一?期/.test(s)) return false;
  return /(选择|选|挑|找|找出|匹配|帮我选|帮我选择|帮我找|给我挑|给我找|选出|安排|量产|创作|做).{0,24}(账号|号|图文|素材|真人|数字人)/.test(s);
}

export async function handleUserText(text) {
  const session = ensureSession();
  session.title = (text || "").slice(0, 18) || "量产计划";
  save("sessions");
  emit("agent:thinking", { sessionId: session.id, value: true });
  think("读取工作台上下文…", session.id);
  try {
    const r = await routeIntent(text, contextSummary());
    think(`识别意图 · ${INTENT_LABEL[r.intent] || r.intent}`, session.id);
    const fb = parseGoalFallback(text);
    const params = { ...(r.params || {}), ...fb };
    if (fb.group && fb.group !== "all") params.group = fb.group;
    if (fb.accountCount != null) params.accountCount = fb.accountCount;
    if (fb.perAccountCount != null) params.perAccountCount = fb.perAccountCount;
    if (fb.count != null) params.count = fb.count;
    if (fb.sort) params.sort = fb.sort;
    if (fb.pickFrom) params.pickFrom = fb.pickFrom;
    if (isPureAccountSelection(text)) params.topic = "";
    think("按分组、标签、活跃度匹配账号矩阵…", session.id);
    const matched = selectAccountsForPlan(params);
    const accountCount = Number(params.accountCount || params.count) || matched.length;
    const perAccountCount = Math.max(1, Math.min(12, Number(params.perAccountCount || 1) || 1));
    think(`命中 ${matched.length} 个账号 · 每号 ${perAccountCount} 条 · 生成量产任务板`, session.id);
    const wantsRandom = /随机主题|各自主题|主题随机/.test(text) || !params.topic;
    const payload = {
      status: "pending", goal: text,
      topicMode: wantsRandom ? "random" : "fixed",
      topic: params.topic || "", productId: "dumate", content: "",
      accountProductIds: {}, accountContents: {},
      accountCounts: {},
      accountImageCounts: {},
      imageCount: DEFAULT_XHS_IMAGE_COUNT,
      style: params.style || "", tags: params.tags || [], group: params.group || "all",
      sort: params.sort || "",
      pickFrom: params.pickFrom || "",
      accountCount, perAccountCount,
      accountIds: matched.map(a => a.id),
      sharedRefAssetIds: [], accountRefAssetIds: {}
    };
    const existing = [...session.messages].reverse().find(m => m.type === "plan" && m.payload?.status === "pending");
    if (existing) {
      existing.payload = { ...existing.payload, ...payload };
      save("sessions");
      emit("agent:session");
    } else {
      addMsg(session, { role: "agent", type: "plan", payload });
    }
  } finally {
    emit("agent:thinking", { sessionId: session.id, value: false });
  }
}

export function statusText() {
  const bs = activeBatches();
  if (!bs.length) {
    const n = state.productions.filter(p => p.stage !== "delivered").length;
    return n ? `当前没有进行中的批次，但有 ${n} 条在制任务散落在单号创作。一句话告诉我主题，我可以发起一批新的量产。` : "一切就绪。说出主题（可带标签/范围/风格），例如：「给所有职场效率账号做一期下班前自动生成日报，偏教程风」。";
  }
  return bs.map(b => {
    const prods = batchProds(b);
    const phase = { drafting: "批量起草中", awaiting_input: "等待分镜上传", generating: "生成中", review: "待审核", done: "已完成" }[b.phase] || b.phase;
    const fail = prods.filter(p => p.stageStatus === "failed").length;
    const done = prods.filter(p => p.stage === "delivered").length;
    return `「${b.topic}」：${phase} · ${done}/${prods.length} 已交付${fail ? ` · ${fail} 条失败（说"重试失败的"即可）` : ""}`;
  }).join("\n");
}
