/* 生成失败终态契约：旧“等待上传”只用于一次性兼容读取，不能再成为运行状态。 */

export const LEGACY_INPUT_STATUS = "needs_input";
export const LEGACY_INPUT_PHASE = "awaiting_input";
export const TERMINAL_FAILURE_MARKER = "legacy-upload-fallback-removed";

const ACTIVE_JOB_STATUSES = new Set(["queued", "submitted", "running"]);

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
  return production?.stageStatus === "failed" || production?.stageStatus === "pending";
}
