/* 生成失败终态契约：旧“等待上传”只用于一次性兼容读取，不能再成为运行状态。 */

export const LEGACY_INPUT_STATUS = "needs_input";
export const LEGACY_INPUT_PHASE = "awaiting_input";
export const TERMINAL_FAILURE_MARKER = "legacy-upload-fallback-removed";

const ACTIVE_JOB_STATUSES = new Set(["queued", "submitted", "running"]);
const VIDEO_SETTLEMENT_STAGES = new Set(["render", "workshop"]);

const MEDIA_OUTPUT_KEYS = ["url", "videoUrl", "video_url", "result_url", "downloadUrl", "download_url", "src"];
const MEDIA_CONTAINER_KEYS = ["data", "result", "results", "output", "outputs", "video", "videos", "media"];

function mediaLocator(value, knownMediaKey = false) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[\u0000-\u001f]/.test(text)) return "";
  if (/^(?:https?:|blob:|data:)/i.test(text)) return text;
  const videoPath = /\.(?:mp4|mov|m4v|webm|mkv|avi)(?:[?#].*)?$/i.test(text);
  if (videoPath && (/^(?:\/|\.\/)/.test(text) || knownMediaKey)) return text;
  return "";
}

export function recoverableVideoUrl(value, knownMediaKey = false) {
  if (!value) return "";
  if (typeof value === "string") return mediaLocator(value, knownMediaKey);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = recoverableVideoUrl(item, knownMediaKey);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of MEDIA_OUTPUT_KEYS) {
      const found = recoverableVideoUrl(value[key], true);
      if (found) return found;
    }
    for (const key of MEDIA_CONTAINER_KEYS) {
      const found = recoverableVideoUrl(value[key], true);
      if (found) return found;
    }
  }
  return "";
}

function expectedVideoSegmentCount(production, jobs) {
  const boards = production?.artifacts?.boards || {};
  const digitalSegments = boards?.generationMode === "digitalHuman"
    ? boards?.digitalHuman?.segments
    : null;
  if (Array.isArray(digitalSegments) && digitalSegments.length) return digitalSegments.length;
  if (Array.isArray(boards.units) && boards.units.length) return boards.units.length;
  const prompts = production?.artifacts?.prompts;
  if (Array.isArray(prompts) && prompts.length) {
    return prompts.reduce((count, prompt) => count + 1 + (prompt?.back ? 1 : 0), 0);
  }
  const segmentKeys = new Set(jobs.map((job, index) => {
    if (job?.segmentId) return `id:${job.segmentId}`;
    if (Number.isFinite(Number(job?.segIndex))) return `index:${Number(job.segIndex)}`;
    return `job:${job?.id || index}`;
  }));
  return segmentKeys.size;
}

function jobHasRecoverableOutput(production, job) {
  if (recoverableVideoUrl(job?.output, true)) return true;
  const timeline = Array.isArray(production?.artifacts?.timeline) ? production.artifacts.timeline : [];
  if (timeline.some(clip => clip?.jobId === job?.id && recoverableVideoUrl(clip?.videoUrl, true))) return true;
  const segments = production?.artifacts?.boards?.digitalHuman?.segments;
  if (!Array.isArray(segments)) return false;
  const segment = segments.find((item, index) => (
    (job?.segmentId && item?.id === job.segmentId)
    || (!job?.segmentId && Number(job?.segIndex) === index)
  ));
  return Boolean(recoverableVideoUrl(segment?.videoOutput, true));
}

/*
 * Pure hydration classifier. It never submits a provider request or mutates
 * workspace state; the orchestrator applies the returned action only after
 * its normal owner guard has passed.
 */
export function classifyHydratedVideoSettlement(production, workspaceJobs = []) {
  if (!production
    || production.mode !== "视频"
    || production.stage === "delivered"
    || production.stageStatus !== "running"
    || !VIDEO_SETTLEMENT_STAGES.has(production.stage)) {
    return { action: "none", reason: "not-candidate", expectedSegments: 0, effectiveJobs: 0 };
  }
  const finalOutputUrl = recoverableVideoUrl(production?.artifacts?.finalVideoUrl, true);
  if (finalOutputUrl) {
    return { action: "review", reason: "final-output-present", mediaUrl: finalOutputUrl, expectedSegments: 0, effectiveJobs: 0 };
  }
  // 静态视频不使用主平台 jobs；无成片时交给原有 static resume 链路处理。
  if (production.staticVideo) {
    return { action: "none", reason: "static-resume-owned", expectedSegments: 0, effectiveJobs: 0 };
  }
  const jobs = (Array.isArray(workspaceJobs) ? workspaceJobs : []).filter(job => (
    job?.productionId === production.id
    && !job.superseded
    && (!job.kind || job.kind === "video")
  ));
  const expectedSegments = expectedVideoSegmentCount(production, jobs);
  const base = { expectedSegments, effectiveJobs: jobs.length };
  if (jobs.some(job => ACTIVE_JOB_STATUSES.has(job.status))) {
    return { action: "none", reason: "active-jobs-present", ...base };
  }
  const failed = jobs.find(job => job.status === "failed");
  if (failed) {
    return {
      action: "failed",
      reason: "terminal-job-failed",
      error: String(failed.error || "部分视频片段生成失败，请明确重试"),
      ...base,
    };
  }
  if (!jobs.length || !expectedSegments) {
    return {
      action: "failed",
      reason: "missing-recoverable-jobs",
      error: "任务停留在生成中，但刷新后没有可验证的完整成片或有效视频任务，请明确重试",
      ...base,
    };
  }
  const nonSucceeded = jobs.find(job => job.status !== "succeeded");
  if (nonSucceeded) {
    return {
      action: "failed",
      reason: "unknown-terminal-job-state",
      error: `视频任务以未知终态停止（${nonSucceeded.status || "unknown"}），请明确重试`,
      ...base,
    };
  }
  const missingIndex = Array.from({ length: expectedSegments }, (_, index) => index).find(index => (
    !jobs.some(job => Number(job.segIndex) === index && jobHasRecoverableOutput(production, job))
  ));
  if (missingIndex !== undefined) {
    return {
      action: "failed",
      reason: "incomplete-succeeded-output-set",
      error: `已成功任务缺少第 ${missingIndex + 1} 个可合成视频输出，请明确重试`,
      ...base,
    };
  }
  return { action: "compose", reason: "all-segments-succeeded", ...base };
}

export function batchNeedsHydrationEvaluation(batch, productions = []) {
  if (!batch || batch.phase !== "generating") return false;
  const ids = new Set(Array.isArray(batch.productionIds) ? batch.productionIds : []);
  const linked = (Array.isArray(productions) ? productions : []).filter(production => ids.has(production?.id));
  if (!linked.length) return false;
  const hasRealActiveWork = linked.some(production => (
    production?.stage !== "delivered"
    && production?.stageStatus !== "failed"
    && ["script", "images", "render", "workshop"].includes(production?.stage)
    && ["pending", "running"].includes(production?.stageStatus)
  ));
  return !hasRealActiveWork;
}

function readableLegacyFailure(production) {
  const boards = production?.artifacts?.boards || {};
  const items = production?.mode === "图文"
    ? production?.artifacts?.images?.items
    : boards.items;
  const itemError = (Array.isArray(items) ? items : [])
    .map(item => String(item?.error || "").trim())
    .find(Boolean);
  return String(
    production?.error
    || boards?.digitalHuman?.error
    || production?.artifacts?.audio?.lastError
    || itemError
    || "旧版任务曾进入等待人工补图；该兜底已移除，请重试站内生成或主动打开任务上传素材。"
  ).trim();
}

function markUnresolvedItemsFailed(production, error) {
  const items = production?.mode === "图文"
    ? production?.artifacts?.images?.items
    : production?.artifacts?.boards?.items;
  (Array.isArray(items) ? items : []).forEach(item => {
    if (item?.assetId) return;
    item.status = "failed";
    item.error = String(item.error || error);
  });
}

/*
 * Mutates a workspace-shaped object and returns precise change counts.
 * It is intentionally idempotent so a stale server snapshot or IndexedDB cache
 * cannot revive a terminal failure after refresh.
 */
export function normalizeLegacyInputFallbackState(workspace = {}) {
  const productions = Array.isArray(workspace.productions) ? workspace.productions : [];
  const batches = Array.isArray(workspace.batches) ? workspace.batches : [];
  const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : [];
  const jobs = Array.isArray(workspace.jobs) ? workspace.jobs : [];
  const legacyProductionIds = new Set();
  const changed = { productions: 0, batches: 0, sessions: 0, jobs: 0 };

  productions.forEach(production => {
    if (!production || production.stageStatus !== LEGACY_INPUT_STATUS) {
      if (production?.failureTerminalMarker === TERMINAL_FAILURE_MARKER) {
        legacyProductionIds.add(String(production.id || ""));
      }
      return;
    }
    const error = readableLegacyFailure(production);
    production.stageStatus = "failed";
    production.error = error;
    production.failureTerminalMarker = TERMINAL_FAILURE_MARKER;
    markUnresolvedItemsFailed(production, error);
    legacyProductionIds.add(String(production.id || ""));
    changed.productions += 1;
  });

  batches.forEach(batch => {
    if (!batch || batch.phase !== LEGACY_INPUT_PHASE) return;
    batch.phase = "review";
    if (batch.emitted && typeof batch.emitted === "object") {
      delete batch.emitted.awaiting_input;
      delete batch.emitted.allfail;
    }
    changed.batches += 1;
  });

  sessions.forEach(session => {
    if (!Array.isArray(session?.messages)) return;
    const kept = session.messages.filter(message => message?.type !== "need_input");
    if (kept.length === session.messages.length) return;
    session.messages = kept;
    changed.sessions += 1;
  });

  jobs.forEach(job => {
    if (!job || !legacyProductionIds.has(String(job.productionId || ""))) return;
    if (!ACTIVE_JOB_STATUSES.has(job.status)) return;
    job.status = "failed";
    job.progress = 0;
    job.nextPollAt = 0;
    job.nextAttemptAt = 0;
    job.error = String(job.error || "所属任务已进入失败终态，旧版等待上传兜底已移除。请从任务页明确重试。");
    changed.jobs += 1;
  });

  return changed;
}

export function productionCanAutoGenerate(production) {
  return production?.stageStatus === "pending";
}

export function productionAllowsJobProcessing(production) {
  return !production || production.stageStatus !== "failed";
}

export function productionCanAdvanceAfterExplicitUpload(production) {
  if (["failed", "pending"].includes(String(production?.stageStatus || ""))) return true;
  // A batch item may be opened in the single-account workshop while its
  // production still says running. Once every image slot is durably bound,
  // that workshop completion is authoritative and may settle to review.
  return production?.stage === "images" && production?.stageStatus === "running";
}
