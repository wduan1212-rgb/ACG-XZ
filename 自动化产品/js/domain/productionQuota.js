import { state } from "../core/store.js";
import * as remote from "../core/remote.js";
import { shanghaiDayKey } from "./publishSchedule.js?v=20260817-v1436-token-plan-knowledge-2";

export const ACCOUNT_DAILY_PUBLISH_LIMIT = 2;

const cache = new Map();
const inflight = new Map();
const CACHE_TTL_MS = 10_000;
const AUTO_REFRESH_MS = 15_000;
let autoRefreshInstalled = false;

function quotaDayKey(value = "") {
  const dayKey = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey : shanghaiDayKey();
}

function cacheKey(accountId, dayKey) {
  return `${quotaDayKey(dayKey)}:${String(accountId || "")}`;
}

function deliveryPublishDayKey(delivery = {}) {
  const stamped = String(delivery.quotaDayKey || "");
  if (stamped) return stamped;
  const planned = String(delivery.planDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(planned)) return planned;
  const publishedAt = Number(
    delivery.quotaPublishedAt || delivery.deliveredAt || delivery.createdAt || 0
  );
  return publishedAt > 0 ? shanghaiDayKey(publishedAt) : "";
}

function localUsed(accountId, dayKey = shanghaiDayKey()) {
  const selectedDay = quotaDayKey(dayKey);
  return state.assets.filter(asset => (
    String(asset?.accountId || "") === String(accountId || "")
    && asset?.delivered
    && deliveryPublishDayKey(asset) === selectedDay
  )).length;
}

export function accountPublishQuota(accountId, dayKey = shanghaiDayKey()) {
  const id = String(accountId || "");
  const selectedDay = quotaDayKey(dayKey);
  const local = localUsed(id, selectedDay);
  const stored = cache.get(cacheKey(id, selectedDay));
  const current = stored?.dayKey === selectedDay ? Number(stored.used || 0) : 0;
  const used = Math.max(0, local, current);
  const limit = Math.max(1, Number(stored?.limit || ACCOUNT_DAILY_PUBLISH_LIMIT));
  return {
    accountId: id,
    dayKey: selectedDay,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    authoritative: Boolean(stored?.authoritative),
  };
}

export function accountPublishAvailable(accountId, requested = 1, dayKey = shanghaiDayKey()) {
  return accountPublishQuota(accountId, dayKey).remaining >= Math.max(1, Number(requested) || 1);
}

export function publishQuotaExceededMessage(accountIds = [], dayKey = shanghaiDayKey()) {
  const names = [...new Set((accountIds || []).map(id => (
    state.accounts.find(account => String(account.id) === String(id))?.name || String(id)
  )))].slice(0, 3);
  return `${names.join("、")}${accountIds.length > 3 ? "等账号" : ""}${quotaDayKey(dayKey)} 已达每个账号 ${ACCOUNT_DAILY_PUBLISH_LIMIT} 条的发布上限`;
}

export function invalidateAccountPublishQuotas(accountIds = []) {
  const ids = new Set((accountIds || []).map(accountId => String(accountId || "")));
  [...cache.keys()].forEach(key => {
    const accountId = String(key).split(":").slice(1).join(":");
    if (ids.has(accountId)) cache.delete(key);
  });
}

function announceQuotaChange(accountIds, dayKey) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  if (typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("xingzhen:account-publish-quotas", {
      detail: { accountIds: [...accountIds], dayKey: quotaDayKey(dayKey) }
    }));
  }
}

export async function refreshAccountPublishQuotas(accountIds = [], { force = false, dayKey = shanghaiDayKey() } = {}) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  if (!ids.length || !remote.isOn() || !remote.hasToken()) return false;
  const selectedDay = quotaDayKey(dayKey);
  const now = Date.now();
  const needed = ids.filter(id => {
    const stored = cache.get(cacheKey(id, selectedDay));
    return force || !stored || now - Number(stored.fetchedAt || 0) >= CACHE_TTL_MS;
  });
  if (!needed.length) return false;
  const key = `${selectedDay}|${[...needed].sort().join(",")}`;
  if (inflight.has(key)) return inflight.get(key);
  const task = remote.accountPublishQuotas(needed, selectedDay).then(result => {
    if (!result) return false;
    const before = needed.map(id => JSON.stringify(accountPublishQuota(id, selectedDay))).join("|");
    const byId = new Map((result.items || []).map(item => [String(item.accountId), item]));
    needed.forEach(id => {
      const item = byId.get(id) || { used: 0, remaining: Number(result.limit || ACCOUNT_DAILY_PUBLISH_LIMIT) };
      cache.set(cacheKey(id, selectedDay), {
        dayKey: String(result.dayKey || selectedDay),
        limit: Number(result.limit || ACCOUNT_DAILY_PUBLISH_LIMIT),
        used: Number(item.used || 0),
        remaining: Number(item.remaining || 0),
        authoritative: true,
        fetchedAt: Date.now(),
      });
    });
    const changed = before !== needed.map(id => JSON.stringify(accountPublishQuota(id, selectedDay))).join("|");
    if (changed) announceQuotaChange(needed, selectedDay);
    return changed;
  }).catch(error => {
    console.warn("发布配额同步失败", error);
    return false;
  }).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

export function installAccountPublishQuotaAutoRefresh() {
  if (
    autoRefreshInstalled
    || typeof window === "undefined"
    || typeof document === "undefined"
  ) return;
  autoRefreshInstalled = true;
  const refreshVisible = () => {
    if (document.hidden) return;
    void refreshAccountPublishQuotas(
      state.accounts.map(account => account.id),
      { force: true },
    );
  };
  window.addEventListener("focus", refreshVisible);
  document.addEventListener("visibilitychange", refreshVisible);
  const timer = setInterval(refreshVisible, AUTO_REFRESH_MS);
  timer?.unref?.();
}
