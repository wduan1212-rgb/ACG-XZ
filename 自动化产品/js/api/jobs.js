/* JobRunner：生成任务队列（持久化 / 并发 2 / 轮询 / 重试 / 取消 / 刷新恢复）
   所有"生成"动作（站内视频、站内图片）都经由 job，UI 订阅 job 事件渲染状态 */

import { state, save, emit, productionById, notify, assetById } from "../core/store.js";
import { uid } from "../core/util.js";
import { activeProviderFor, providerKeyFor } from "./providers.js";
import { assetBlob, urlFor } from "../domain/assets.js";

const CONCURRENCY = 2;
const POLL_MS = 700;
let timer = null;

export function createJob({ kind = "video", productionId, segIndex = 0, segName = "", prompt, refAssetIds = [], ratio = "9:16", duration = 15, generateAudio = null }) {
  const job = {
    id: uid(), kind, productionId, segIndex, segName,
    prompt, refAssetIds, ratio, duration, generateAudio,
    provider: null, providerRef: null,
    status: "queued", progress: 0, attempts: 0,
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
  j.updatedAt = Date.now();
  save("jobs"); emit("job:update", j);
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
}

function activeJobs() {
  return state.jobs.filter(j => j.status === "submitted" || j.status === "running");
}
function queuedJobs() {
  return state.jobs.filter(j => j.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
}

async function tick() {
  // 1) 轮询进行中的
  for (const j of activeJobs()) {
    const p = activeProviderFor(j.kind);
    if (!p || !j.providerRef) { failJob(j, "Provider 不可用"); continue; }
    try {
      const r = await p.poll(j.providerRef);
      if (r.status === "succeeded") {
        j.status = "succeeded"; j.progress = 100; j.output = r.output || {}; j.updatedAt = Date.now();
        save("jobs"); emit("job:update", j); emit("job:done", j);
      } else if (r.status === "failed") {
        failJob(j, r.error || "生成失败");
      } else {
        if (r.progress !== j.progress) { j.progress = r.progress; j.status = "running"; j.updatedAt = Date.now(); emit("job:update", j); }
      }
    } catch (e) { failJob(j, e.message || "轮询失败"); }
  }
  // 2) 队列补位
  const slots = CONCURRENCY - activeJobs().length;
  if (slots > 0) {
    for (const j of queuedJobs().slice(0, slots)) {
      const p = activeProviderFor(j.kind);
      if (!p) { failJob(j, "未注册可用的生成服务"); continue; }
      try {
        j.attempts++;
        const refs = await refsForJob(j);
        const key = providerKeyFor(j.kind, p);
        const endpoint = /^https?:\/\//.test(key?.provider || "") ? key.provider : key?.endpoint || "";
        const { providerRef } = await p.submit({
          prompt: j.prompt, refs, ratio: j.ratio, duration: j.duration,
          generateAudio: j.generateAudio,
          attempt: j.attempts - 1,
          apiKey: key?.secret || "",
          endpoint,
          providerConfig: key || null
        });
        j.provider = p.id; j.providerRef = providerRef;
        j.status = "submitted"; j.progress = 1; j.updatedAt = Date.now();
        save("jobs"); emit("job:update", j);
      } catch (e) { failJob(j, e.message || "提交失败"); }
    }
  }
  // 3) 空转时停表
  if (!activeJobs().length && !queuedJobs().length) stop();
}

async function refsForJob(j) {
  const ids = [...new Set(j.refAssetIds || [])].slice(0, 9);
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
  j.status = "failed"; j.error = msg; j.updatedAt = Date.now();
  save("jobs"); emit("job:update", j); emit("job:done", j);
  const p = productionById(j.productionId);
  notify("job", `生成失败：${j.segName || "片段"}`, `${p ? p.title || p.topic : ""} · ${msg}`);
}

export function ensureRunning() {
  if (timer) return;
  timer = setInterval(tick, POLL_MS);
  tick();
}
function stop() { clearInterval(timer); timer = null; }

/* 启动恢复：刷新前在跑/排队的任务 → 重新排队（mock 引擎无法续断点；真实引擎可凭 providerRef 续 poll） */
export function resumeJobs() {
  let n = 0;
  state.jobs.forEach(j => {
    if (j.status === "submitted" || j.status === "running") {
      const p = activeProviderFor(j.kind);
      if (p && p.mock) { j.status = "queued"; j.progress = 0; j.providerRef = null; n++; }
      // 真实 provider：保留 providerRef，直接继续 poll
    }
  });
  if (n) save("jobs");
  if (queuedJobs().length || activeJobs().length) ensureRunning();
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
