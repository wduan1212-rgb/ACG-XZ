/* JobRunner：生成任务队列（持久化 / 并发控制 / 轮询 / 重试 / 取消 / 刷新恢复）
   所有"生成"动作（站内视频、站内图片）都经由 job，UI 订阅 job 事件渲染状态 */

import { state, save, emit, productionById, notify, assetById } from "../core/store.js";
import { uid } from "../core/util.js";
import { activeProviderFor, providerKeyFor } from "./providers.js";
import { assetBlob, urlFor } from "../domain/assets.js";

const CONCURRENCY = 2;
const TICK_MS = 1000;
const DEFAULT_POLL_MS = 8000;
const DIGITAL_HUMAN_POLL_MS = 12000;
const DIGITAL_HUMAN_MAX_POLL_MS = 20000;
const DIGITAL_HUMAN_MAX_ATTEMPTS = 3;
let timer = null;
let ticking = false;

export function createJob({ kind = "video", productionId, segIndex = 0, segName = "", prompt, refAssetIds = [], ratio = "9:16", duration = 15, generateAudio = null, model = "" }) {
  const job = {
    id: uid(), kind, productionId, segIndex, segName,
    prompt, refAssetIds, ratio, duration, generateAudio, model,
    provider: null, providerRef: null,
    status: "queued", progress: 0, attempts: 0,
    nextPollAt: 0, nextAttemptAt: 0,
    output: null, error: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  state.jobs.push(job);
  save("jobs");
  emit("job:update", job);
  ensureRunning();
  return job;
}

export function jobById(id) { return state.jobs.find(j => j.id === id); }

export function retryJob(id) {
  const j = jobById(id); if (!j) return;
  j.status = "queued"; j.progress = 0; j.error = null; j.providerRef = null;
  j.nextPollAt = 0; j.nextAttemptAt = 0;
  j.updatedAt = Date.now();
  save("jobs"); emit("job:update", j);
  syncJobToProduction(j);
  ensureRunning();
}

export async function cancelJob(id) {
  const j = jobById(id); if (!j) return;
  if (j.providerRef && j.provider) {
    const p = activeProviderFor(j.kind);
    try { await p.cancel(j.providerRef); } catch (e) { /* 忽略 */ }
  }
  j.status = "canceled"; j.updatedAt = Date.now();
  save("jobs"); emit("job:update", j);
  syncJobToProduction(j);
}

function activeJobs() {
  return state.jobs.filter(j => j.status === "submitted" || j.status === "running");
}
function queuedJobs() {
  const now = Date.now();
  return state.jobs.filter(j => j.status === "queued" && Number(j.nextAttemptAt || 0) <= now).sort((a, b) => a.createdAt - b.createdAt);
}

function delayedQueuedJobs() {
  const now = Date.now();
  return state.jobs.filter(j => j.status === "queued" && Number(j.nextAttemptAt || 0) > now);
}

function isDigitalHumanJob(j) {
  return j?.kind === "video" && j?.model === "__digital_human__";
}

function isTransientProviderError(message = "") {
  return /Concurrent Limit|API Concurrent|Gateway Time-out|Gateway Timeout|504|TLB|timeout|timed out|Too Many Requests|429|限流|并发|网关超时|temporar/i.test(String(message || ""));
}

function readableProviderError(message = "") {
  const msg = String(message || "生成失败");
  if (isTransientProviderError(msg)) return "OmniHuman 上游限流或网关超时，请稍后重试；系统已按单并发退避处理。";
  return msg;
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
  if (isDigitalHumanJob(j) && isTransientProviderError(message) && Number(j.attempts || 0) < DIGITAL_HUMAN_MAX_ATTEMPTS) {
    j.status = "queued";
    j.progress = 0;
    j.providerRef = null;
    j.error = readableProviderError(message);
    j.nextAttemptAt = Date.now() + nextDelayFor(j);
    j.updatedAt = Date.now();
    save("jobs"); emit("job:update", j); syncJobToProduction(j);
    return true;
  }
  return false;
}

function syncJobToProduction(j) {
  if (!isDigitalHumanJob(j)) return;
  const p = productionById(j.productionId);
  const seg = p?.artifacts?.boards?.digitalHuman?.segments?.[j.segIndex];
  if (!seg) return;
  seg.videoJobId = j.id;
  seg.videoStatus = j.status;
  seg.videoProgress = j.progress || 0;
  seg.providerRef = j.providerRef || "";
  seg.videoOutput = j.output || null;
  seg.videoError = j.error || "";
  seg.videoUpdatedAt = j.updatedAt || Date.now();
  save("productions");
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
  // 1) 轮询进行中的
  for (const j of activeJobs()) {
    const now = Date.now();
    if (Number(j.nextPollAt || 0) > now) continue;
    const p = activeProviderFor(j.kind);
    if (!p || !j.providerRef) { failJob(j, "Provider 不可用"); continue; }
    try {
      const r = await p.poll(j.providerRef);
      if (r.status === "succeeded") {
        j.status = "succeeded"; j.progress = 100; j.output = r.output || {}; j.updatedAt = Date.now();
        j.nextPollAt = 0; j.error = null;
        save("jobs"); emit("job:update", j); syncJobToProduction(j); emit("job:done", j);
      } else if (r.status === "failed") {
        const msg = r.error || "生成失败";
        if (!scheduleSubmitRetry(j, msg)) failJob(j, msg);
      } else {
        j.pollAttempts = Number(j.pollAttempts || 0) + 1;
        j.nextPollAt = Date.now() + pollDelayFor(j);
        if (r.progress !== j.progress || j.status !== "running") {
          j.progress = r.progress; j.status = "running"; j.updatedAt = Date.now();
          save("jobs"); emit("job:update", j); syncJobToProduction(j);
        } else {
          j.updatedAt = Date.now();
          save("jobs");
        }
      }
    } catch (e) {
      const msg = e.message || "轮询失败";
      if (isTransientProviderError(msg)) {
        j.error = readableProviderError(msg);
        j.nextPollAt = Date.now() + pollDelayFor(j);
        j.updatedAt = Date.now();
        save("jobs"); emit("job:update", j); syncJobToProduction(j);
      } else failJob(j, msg);
    }
  }
  // 2) 队列补位
  const slots = CONCURRENCY - activeJobs().length;
  if (slots > 0) {
    const activeDigital = activeJobs().some(isDigitalHumanJob);
    let digitalPicked = false;
    const candidates = [];
    for (const j of queuedJobs()) {
      if (candidates.length >= slots) break;
      if (isDigitalHumanJob(j) && (activeDigital || digitalPicked)) continue;
      if (isDigitalHumanJob(j)) digitalPicked = true;
      candidates.push(j);
    }
    for (const j of candidates) {
      const p = activeProviderFor(j.kind);
      if (!p) { failJob(j, "未注册可用的生成服务"); continue; }
      try {
        j.attempts++;
        j.status = "submitted";
        j.progress = Math.max(1, j.progress || 1);
        j.error = null;
        j.updatedAt = Date.now();
        save("jobs"); emit("job:update", j); syncJobToProduction(j);
        const refs = await refsForJob(j);
        const key = providerKeyFor(j.kind, p);
        const endpoint = /^https?:\/\//.test(key?.provider || "") ? key.provider : key?.endpoint || "";
        const { providerRef } = await p.submit({
          prompt: j.prompt, refs, ratio: j.ratio, duration: j.duration,
          generateAudio: j.generateAudio,
          model: j.model || key?.model || "",
          attempt: j.attempts - 1,
          apiKey: key?.secret || "",
          endpoint,
          providerConfig: key || null
        });
        j.provider = p.id; j.providerRef = providerRef;
        j.status = "submitted"; j.progress = 1; j.nextPollAt = Date.now() + pollDelayFor(j); j.updatedAt = Date.now();
        save("jobs"); emit("job:update", j); syncJobToProduction(j);
      } catch (e) {
        const msg = e.message || "提交失败";
        if (!scheduleSubmitRetry(j, msg)) failJob(j, msg);
      }
    }
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
  save("jobs"); emit("job:update", j); syncJobToProduction(j); emit("job:done", j);
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
  let touched = false;
  state.jobs.forEach(j => {
    if (j.status === "submitted" || j.status === "running") {
      const p = activeProviderFor(j.kind);
      if (p && p.mock) { j.status = "queued"; j.progress = 0; j.providerRef = null; n++; }
      // 真实 provider：保留 providerRef，直接继续 poll
      if (!j.nextPollAt) { j.nextPollAt = Date.now() + pollDelayFor(j); touched = true; }
      syncJobToProduction(j);
    }
  });
  if (n || touched) save("jobs");
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
