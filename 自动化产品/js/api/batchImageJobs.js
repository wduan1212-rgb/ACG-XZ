import * as remote from "../core/remote.js";
import { delay } from "../core/util.js";

async function jsonRequest(path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Authorization": "Bearer " + remote.getToken(),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.detail;
      const message = typeof detail === "string" ? detail : (detail?.message || `HTTP ${response.status}`);
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeout = new Error("后台图片任务请求超时，任务仍会在服务端继续执行");
      timeout.code = "BATCH_IMAGE_JOB_POLL_DEFERRED";
      timeout.retryable = true;
      throw timeout;
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function registerBatchImageJobs(jobs) {
  const prepared = (jobs || []).map(raw => ({
      clientJobId: raw.clientJobId,
      productionId: raw.productionId,
      accountId: raw.accountId,
      itemIndex: raw.itemIndex,
      operationKey: raw.operationKey,
      prompt: raw.prompt,
      refs: raw.refs || [],
      ratio: raw.ratio || "3:4",
      assetName: raw.assetName || "",
  }));
  return jsonRequest("/api/batch-image/generation-jobs", {
    method: "POST",
    body: { jobs: prepared },
    timeoutMs: 30000,
  });
}

export function getBatchImageJob(jobId) {
  return jsonRequest(`/api/batch-image/generation-jobs/${encodeURIComponent(jobId)}`, {
    timeoutMs: 15000,
  });
}

export async function waitForBatchImageJob(jobId, {
  timeoutMs = 30 * 60 * 1000,
  intervalMs = 800,
} = {}) {
  const startedAt = Date.now();
  let transientErrors = 0;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await getBatchImageJob(jobId);
      transientErrors = 0;
      const job = payload?.job || {};
      if (["succeeded", "failed", "confirming"].includes(String(job.status || ""))) return job;
    } catch (error) {
      transientErrors += 1;
      if (Number(error?.status || 0) === 404 || transientErrors >= 5) {
        error.code = error.code || "BATCH_IMAGE_JOB_POLL_DEFERRED";
        error.retryable = true;
        throw error;
      }
    }
    await delay(intervalMs);
  }
  const error = new Error("后台图片任务仍在执行，可稍后刷新查看结果");
  error.code = "BATCH_IMAGE_JOB_POLL_DEFERRED";
  error.retryable = true;
  throw error;
}
