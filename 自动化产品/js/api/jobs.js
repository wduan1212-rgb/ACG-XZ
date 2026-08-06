/* JobRunner：生成任务队列（持久化 / 并发控制 / 轮询 / 重试 / 取消 / 刷新恢复）
   所有"生成"动作（站内视频、站内图片）都经由 job，UI 订阅 job 事件渲染状态 */

import { state, saveIncremental, emit, productionById, notify, assetById } from "../core/store.js";
import { uid } from "../core/util.js";
import { getProvider, providerKeyFor, providerReadyForSubmit } from "./providers.js";
import { assetBlob, urlFor } from "../domain/assets.js";
import { productionAllowsJobProcessing } from "../domain/productionFailureState.js?v=20260806-v140-platform-stability-5";

const IMAGE_CONCURRENCY = 4;
// 与服务端 VideoTaskGate 保持一致：全平台最多同时处理 10 个视频任务，
// 超出的任务留在持久队列中按创建时间补位。普通视频仍单独限制为 3 路，
// 避免信息流/静态视频把数字人的生产槽全部占满。
const VIDEO_CONCURRENCY = 10;
const STANDARD_VIDEO_CONCURRENCY = 3;
const DIGITAL_HUMAN_CONCURRENCY = 10;
const TICK_MS = 1000;
const DEFAULT_POLL_MS = 8000;
const DIGITAL_HUMAN_POLL_MS = 12000;
const DIGITAL_HUMAN_MAX_POLL_MS = 20000;
const DIGITAL_HUMAN_MAX_ATTEMPTS = 3;
let timer = null;
let ticking = false;
const persistJob = job => saveIncremental("jobs", job);
const persistProduction = production => saveIncremental("productions", production);

function outputUrl(output) {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const found = outputUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof output === "object") {
    for (const key of ["url", "videoUrl", "video_url", "result_url"]) {
      const value = output[key];
      if (typeof value === "string" && value) return value;
    }
    for (const value of Object.values(output)) {
      const found = outputUrl(value);
      if (found) return found;
    }
  }
  return "";
}

function normalizeOutput(output) {
  const url = outputUrl(output);
  if (!output && !url) return null;
  if (typeof output === "object" && !Array.isArray(output)) {
    return url && !output.url ? { ...output, url } : output;
  }
  return url ? { url } : null;
}

export function createJob({ kind = "video", productionId, segIndex = 0, segName = "", prompt, refAssetIds = [], ratio = "9:16", duration = 15, generateAudio = null, model = "", segmentId = "" }) {
  const intendedRefAssetIds = [...new Set((refAssetIds || []).filter(Boolean))];
  const job = {
    id: uid(), kind, productionId, segIndex, segName,
    prompt, refAssetIds: intendedRefAssetIds, intendedRefAssetIds, ratio, duration, generateAudio, model,
    segmentId,
    provider: null, providerRef: null,
    status: "queued", progress: 0, attempts: 0,
    nextPollAt: 0, nextAttemptAt: 0,
    output: null, error: null, referenceReceipt: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  state.jobs.push(job);
  persistJob(job);
  emit("job:update", job);
  ensureRunning();
  return job;
}

export function jobById(id) { return state.jobs.find(j => j.id === id); }

export function retryJob(id) {
  const j = jobById(id); if (!j) return;
  j.status = "queued"; j.progress = 0; j.error = null; j.providerRef = null;
  j.referenceReceipt = null;
  j.nextPollAt = 0; j.nextAttemptAt = 0;
  j.updatedAt = Date.now();
  persistJob(j); emit("job:update", j);
  syncJobToProduction(j);
  ensureRunning();
}

export async function cancelJob(id) {
  const j = jobById(id); if (!j) return;
  if (j.providerRef && j.provider) {
    const p = getProvider(j.provider);
    try { if (p) await p.cancel(j.providerRef); } catch (e) { /* 忽略 */ }
  }
  j.status = "canceled"; j.updatedAt = Date.now();
  persistJob(j); emit("job:update", j);
  syncJobToProduction(j);
}

function activeJobs() {
  return state.jobs.filter(j =>
    (j.status === "submitted" || j.status === "running")
    && productionAllowsJobProcessing(productionById(j.productionId)));
}
function queuedJobs() {
  const now = Date.now();
  return state.jobs.filter(j =>
    j.status === "queued"
    && Number(j.nextAttemptAt || 0) <= now
    && productionAllowsJobProcessing(productionById(j.productionId)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

function delayedQueuedJobs() {
  const now = Date.now();
  return state.jobs.filter(j =>
    j.status === "queued"
    && Number(j.nextAttemptAt || 0) > now
    && productionAllowsJobProcessing(productionById(j.productionId)));
}

function isDigitalHumanJob(j) {
  return j?.kind === "video" && j?.model === "__digital_human__";
}

function isVideoJob(j) {
  return j?.kind === "video";
}

export function selectQueuedJobs(active = [], queued = []) {
  const activeImages = active.filter(j => !isVideoJob(j)).length;
  const activeVideos = active.filter(isVideoJob).length;
  const activeStandardVideos = active.filter(j => isVideoJob(j) && !isDigitalHumanJob(j)).length;
  const activeDigitalVideos = active.filter(isDigitalHumanJob).length;
  const imageSlots = Math.max(0, IMAGE_CONCURRENCY - activeImages);
  const videoSlots = Math.max(0, VIDEO_CONCURRENCY - activeVideos);
  const standardVideoSlots = Math.max(0, STANDARD_VIDEO_CONCURRENCY - activeStandardVideos);
  const digitalVideoSlots = Math.max(0, DIGITAL_HUMAN_CONCURRENCY - activeDigitalVideos);
  const limit = imageSlots + videoSlots;
  let imagePicked = 0;
  let videoPicked = 0;
  let standardVideoPicked = 0;
  let digitalVideoPicked = 0;
  const candidates = [];
  for (const job of queued) {
    if (candidates.length >= limit) break;
    if (!isVideoJob(job)) {
      if (imagePicked >= imageSlots) continue;
      imagePicked += 1;
    } else {
      if (videoPicked >= videoSlots) continue;
      if (isDigitalHumanJob(job)) {
        if (digitalVideoPicked >= digitalVideoSlots) continue;
        digitalVideoPicked += 1;
      } else {
        if (standardVideoPicked >= standardVideoSlots) continue;
        standardVideoPicked += 1;
      }
      videoPicked += 1;
    }
    candidates.push(job);
  }
  return candidates;
}

function isLegacyMockVideoJob(j) {
  return j?.kind === "video" && j?.provider === "mock-video" && /^mv_/i.test(String(j?.providerRef || ""));
}

function legacyMockVideoError() {
  return "该视频任务来自旧的模拟渲染，无法在真实视频服务中继续查询。请按当前真实视频服务重新提交。";
}

function isTransientProviderError(message = "") {
  return /Concurrent Limit|API Concurrent|Gateway Time-out|Gateway Timeout|504|TLB|timeout|timed out|Too Many Requests|429|限流|并发|网关超时|temporar/i.test(String(message || ""));
}

function readableProviderError(message = "") {
  const msg = String(message || "生成失败");
  if (isTransientProviderError(msg)) return "OmniHuman 上游限流或网关超时，请稍后重试；系统会自动退避重试。";
  return msg;
}

function isAuthenticationError(message = "") {
  return /(?:HTTP\s*)?401|Unauthorized|未登录|登录.*(?:过期|失效)/i.test(String(message || ""));
}

function holdJobForLogin(j, { preserveProviderRef = false } = {}) {
  const message = "登录已过期，任务已保留；重新登录后会继续。";
  const submitted = preserveProviderRef && !!j.providerRef;
  const nextStatus = submitted
    ? (j.status === "running" ? "running" : "submitted")
    : "queued";
  const changed = j.status !== nextStatus || j.error !== message;
  j.status = nextStatus;
  if (!submitted) {
    j.progress = 0;
    j.providerRef = null;
  }
  j.error = message;
  j.nextPollAt = submitted ? Date.now() + 30_000 : 0;
  j.nextAttemptAt = submitted ? 0 : Date.now() + 30_000;
  if (changed) {
    j.updatedAt = Date.now();
    persistJob(j); emit("job:update", j); syncJobToProduction(j);
  }
  return true;
}

function nextDelayFor(j) {
  const n = Math.max(1, Number(j.attempts || 1));
  return Math.min(45000, 8000 * Math.pow(2, Math.max(0, n - 1)));
}

function pollDelayFor(j) {
  if (!isDigitalHumanJob(j)) return DEFAULT_POLL_MS;
  const n = Math.max(0, Number(j.pollAttempts || 0));
  return Math.min(DIGITAL_HUMAN_MAX_POLL_MS, DIGITAL_HUMAN_POLL_MS + n * 3000);
}

function scheduleSubmitRetry(j, message) {
  if (isAuthenticationError(message)) return holdJobForLogin(j);
  if (isDigitalHumanJob(j) && isTransientProviderError(message) && Number(j.attempts || 0) < DIGITAL_HUMAN_MAX_ATTEMPTS) {
    j.status = "queued";
    j.progress = 0;
    j.providerRef = null;
    j.error = readableProviderError(message);
    j.nextAttemptAt = Date.now() + nextDelayFor(j);
    j.updatedAt = Date.now();
    persistJob(j); emit("job:update", j); syncJobToProduction(j);
    return true;
  }
  return false;
}

function ensureDigitalSegmentForJob(p, j) {
  if (!p?.artifacts) return null;
  const A = p.artifacts.boards || (p.artifacts.boards = {});
  A.digitalHuman = A.digitalHuman || { provider: "", model: "", segments: [] };
  if (!Array.isArray(A.digitalHuman.segments)) A.digitalHuman.segments = [];
  let seg = j.segmentId ? A.digitalHuman.segments.find(x => x.id === j.segmentId) : null;
  if (!seg) seg = A.digitalHuman.segments[j.segIndex];
  if (!seg && Number.isInteger(j.segIndex) && j.segIndex >= 0) {
    while (A.digitalHuman.segments.length <= j.segIndex) {
      A.digitalHuman.segments.push({
        id: uid(),
        shotIndexes: [],
        dur: 0,
        line: "",
        characterRefAssetId: "",
        audioAssetId: null,
        status: "pending"
      });
    }
    seg = A.digitalHuman.segments[j.segIndex];
  }
  if (seg && j.segmentId && !seg.id) seg.id = j.segmentId;
  return seg || null;
}

function syncJobToProduction(j) {
  if (!isDigitalHumanJob(j)) return;
  const p = productionById(j.productionId);
  const seg = ensureDigitalSegmentForJob(p, j);
  if (!seg) return;
  const next = {
    videoJobId: j.id,
    id: j.segmentId || seg.id,
    videoStatus: j.status,
    videoProgress: j.progress || 0,
    providerRef: j.providerRef || "",
    videoOutput: normalizeOutput(j.output),
    videoError: j.error || ""
  };
  const prevOutput = JSON.stringify(seg.videoOutput || null);
  const nextOutput = JSON.stringify(next.videoOutput || null);
  const changed = seg.videoJobId !== next.videoJobId
    || (j.segmentId && seg.id !== next.id)
    || seg.videoStatus !== next.videoStatus
    || Number(seg.videoProgress || 0) !== Number(next.videoProgress || 0)
    || String(seg.providerRef || "") !== next.providerRef
    || prevOutput !== nextOutput
    || String(seg.videoError || "") !== next.videoError;
  if (!changed) return;
  const structuralChange = seg.videoStatus !== next.videoStatus
    || prevOutput !== nextOutput
    || String(seg.videoError || "") !== next.videoError;
  Object.assign(seg, next);
  // 只在终态、输出或错误结构真实变化时刷新 production 时间戳；
  // 普通轮询进度不能把媒体节点误判成新输出。
  if (structuralChange) p.updatedAt = Date.now();
  persistProduction(p);
  emit("production:update", p);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
  // 1) 轮询进行中的
  for (const j of activeJobs()) {
    const now = Date.now();
    if (Number(j.nextPollAt || 0) > now) continue;
    if (isLegacyMockVideoJob(j)) { failJob(j, legacyMockVideoError()); continue; }
    const p = j.provider ? getProvider(j.provider) : null;
    if (!p || !j.providerRef) { failJob(j, "Provider 不可用"); continue; }
    try {
      const r = await p.poll(j.providerRef);
      if (r.status === "succeeded") {
        j.status = "succeeded"; j.progress = 100; j.output = normalizeOutput(r.output); j.updatedAt = Date.now();
        j.referenceReceipt = r.referenceReceipt || r.output?.referenceReceipt || j.referenceReceipt || null;
        j.nextPollAt = 0; j.error = null;
        persistJob(j); emit("job:update", j); syncJobToProduction(j); emit("job:done", j);
      } else if (r.status === "failed") {
        const msg = r.error || "生成失败";
        if (!scheduleSubmitRetry(j, msg)) failJob(j, msg);
      } else {
        j.pollAttempts = Number(j.pollAttempts || 0) + 1;
        j.nextPollAt = Date.now() + pollDelayFor(j);
        if (r.progress !== j.progress || j.status !== "running") {
          j.progress = r.progress; j.status = "running"; j.updatedAt = Date.now();
          persistJob(j); emit("job:update", j); syncJobToProduction(j);
        }
      }
    } catch (e) {
      const msg = e.message || "轮询失败";
      if (isAuthenticationError(msg)) {
        // The upstream task already exists. Keep providerRef so a later login
        // resumes polling instead of submitting and charging for a duplicate.
        holdJobForLogin(j, { preserveProviderRef: true });
      } else if (isTransientProviderError(msg)) {
        const readable = readableProviderError(msg);
        const changed = j.error !== readable;
        j.error = readable;
        j.nextPollAt = Date.now() + pollDelayFor(j);
        if (changed) {
          j.updatedAt = Date.now();
          persistJob(j); emit("job:update", j); syncJobToProduction(j);
        }
      } else failJob(j, msg);
    }
  }
  // 2) 队列补位
  const active = activeJobs();
  const candidates = selectQueuedJobs(active, queuedJobs());
  if (candidates.length) {
    const submitCandidate = async j => {
      try {
        const p = await providerReadyForSubmit(j.kind);
        j.attempts++;
        j.provider = p.id;
        j.status = "submitted";
        j.progress = Math.max(1, j.progress || 1);
        j.error = null;
        j.updatedAt = Date.now();
        persistJob(j); emit("job:update", j); syncJobToProduction(j);
        const refs = await refsForJob(j);
        const key = providerKeyFor(j.kind, p);
        const endpoint = /^https?:\/\//.test(key?.provider || "") ? key.provider : key?.endpoint || "";
        const intendedRefAssetIds = [...new Set((j.intendedRefAssetIds || j.refAssetIds || []).filter(Boolean))];
        j.intendedRefAssetIds = intendedRefAssetIds;
        const { providerRef, referenceReceipt = null } = await p.submit({
          prompt: j.prompt, refs, ratio: j.ratio, duration: j.duration,
          intendedRefAssetIds,
          generateAudio: j.generateAudio,
          model: j.model || key?.model || "",
          attempt: j.attempts - 1,
          apiKey: key?.secret || "",
          endpoint,
          providerConfig: key || null
        });
        j.provider = p.id; j.providerRef = providerRef;
        j.referenceReceipt = referenceReceipt;
        j.status = "submitted"; j.progress = 1; j.nextPollAt = Date.now() + pollDelayFor(j); j.updatedAt = Date.now();
        persistJob(j); emit("job:update", j); syncJobToProduction(j);
      } catch (e) {
        if (e?.referenceReceipt) j.referenceReceipt = e.referenceReceipt;
        const msg = e.message || "提交失败";
        if (!scheduleSubmitRetry(j, msg)) failJob(j, msg);
      }
    };
    // 浏览器内先按类型补位；服务端还会对所有成员执行全局 FIFO 保护。
    await Promise.allSettled(candidates.map(submitCandidate));
  }
  // 3) 空转时停表
  if (!activeJobs().length && !queuedJobs().length && !delayedQueuedJobs().length) stop();
  } finally {
    ticking = false;
  }
}

async function refsForJob(j) {
  const ids = [...new Set(j.refAssetIds || [])].slice(0, 15);
  const refs = [];
  for (const id of ids) {
    const a = assetById(id);
    if (!a) continue;
    let blob = null;
    try { blob = await assetBlob(id); } catch (e) { blob = null; }
    const url = urlFor(a);
    if (!blob && !url) continue;
    refs.push({
      id: a.id,
      name: a.name || id,
      type: a.type || "图片",
      mime: a.mime || (blob && blob.type) || "",
      tags: a.tags || [],
      blob,
      url
    });
  }
  return refs;
}

function failJob(j, msg) {
  j.status = "failed"; j.error = readableProviderError(msg); j.nextPollAt = 0; j.nextAttemptAt = 0; j.updatedAt = Date.now();
  persistJob(j); emit("job:update", j); syncJobToProduction(j); emit("job:done", j);
  const p = productionById(j.productionId);
  notify("job", `生成失败：${j.segName || "片段"}`, `${p ? p.title || p.topic : ""} · ${j.error}`);
}

export function ensureRunning() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  tick();
}
function stop() { clearInterval(timer); timer = null; }

/* 启动恢复：刷新前在跑/排队的任务 → 重新排队（mock 引擎无法续断点；真实引擎可凭 providerRef 续 poll） */
export function resumeJobs() {
  let n = 0;
  const touched = [];
  state.jobs.forEach(j => {
    if (!productionAllowsJobProcessing(productionById(j.productionId))) {
      if (["queued", "submitted", "running"].includes(j.status)) {
        j.status = "failed";
        j.progress = 0;
        j.nextPollAt = 0;
        j.nextAttemptAt = 0;
        j.error = j.error || "所属任务已经失败；刷新不会自动恢复或重新提交，请从任务页明确重试。";
        j.updatedAt = Date.now();
        touched.push(j);
      }
      return;
    }
    if (j.status === "submitted" || j.status === "running") {
      if (isLegacyMockVideoJob(j)) {
        j.status = "failed";
        j.error = legacyMockVideoError();
        j.nextPollAt = 0;
        j.updatedAt = Date.now();
        syncJobToProduction(j);
        touched.push(j);
        return;
      }
      if (!j.providerRef) { j.status = "queued"; j.progress = 0; j.updatedAt = Date.now(); n++; touched.push(j); }
      // 已持久化 provider 的真实任务保留引用，按原 provider 继续轮询。
      if (!j.nextPollAt) j.nextPollAt = Date.now() + pollDelayFor(j);
      syncJobToProduction(j);
    }
  });
  if (touched.length) saveIncremental("jobs", touched);
  if (queuedJobs().length || delayedQueuedJobs().length || activeJobs().length) ensureRunning();
  return n;
}

/* 为 production 的所有片段批量建 job（已成功的段跳过） */
export function createRenderJobsFor(p, segments, { ratio = "9:16" } = {}) {
  const refIds = collectRefAssetIds(p);
  const jobs = [];
  segments.forEach((s, i) => {
    const done = state.jobs.some(j => j.productionId === p.id && j.segIndex === i && j.status === "succeeded");
    if (done) return;
    jobs.push(createJob({
      kind: "video", productionId: p.id, segIndex: i, segName: s.name,
      prompt: s.prompt, refAssetIds: refIds, ratio
    }));
  });
  return jobs;
}

export function collectRefAssetIds(p) {
  const ids = (p.artifacts.boards.items || []).map(x => x.assetId).filter(Boolean);
  return ids;
}
