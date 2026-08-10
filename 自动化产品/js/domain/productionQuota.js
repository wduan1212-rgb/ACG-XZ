import { state } from "../core/store.js";
import * as remote from "../core/remote.js";

export const ACCOUNT_DAILY_PUBLISH_LIMIT = 2;

const cache = new Map();
const inflight = new Map();
const CACHE_TTL_MS = 10_000;
const AUTO_REFRESH_MS = 15_000;
let autoRefreshInstalled = false;

function chinaDayKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(Number(timestamp) || Date.now()));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function deliveryPublishDayKey(delivery = {}) {
  const stamped = String(delivery.quotaDayKey || "");
  if (stamped) return stamped;
  const publishedAt = Number(
    delivery.quotaPublishedAt || delivery.deliveredAt || delivery.createdAt || 0
  );
  return publishedAt > 0 ? chinaDayKey(publishedAt) : "";
}

function localUsed(accountId) {
  const today = chinaDayKey();
  return state.assets.filter(asset => (
    String(asset?.accountId || "") === String(accountId || "")
    && asset?.delivered
    && deliveryPublishDayKey(asset) === today
  )).length;
}

export function accountPublishQuota(accountId) {
  const id = String(accountId || "");
  const local = localUsed(id);
  const stored = cache.get(id);
  const current = stored?.dayKey === chinaDayKey() ? Number(stored.used || 0) : 0;
  const used = Math.max(0, local, current);
  const limit = Math.max(1, Number(stored?.limit || ACCOUNT_DAILY_PUBLISH_LIMIT));
  return {
    accountId: id,
    dayKey: chinaDayKey(),
    used,
    limit,
    remaining: Math.max(0, limit - used),
    authoritative: Boolean(stored?.authoritative),
  };
}

export function accountPublishAvailable(accountId, requested = 1) {
  return accountPublishQuota(accountId).remaining >= Math.max(1, Number(requested) || 1);
}

export function publishQuotaExceededMessage(accountIds = []) {
  const names = [...new Set((accountIds || []).map(id => (
    state.accounts.find(account => String(account.id) === String(id))?.name || String(id)
  )))].slice(0, 3);
  return `${names.join("、")}${accountIds.length > 3 ? "等账号" : ""}今日已达每个账号 ${ACCOUNT_DAILY_PUBLISH_LIMIT} 条的发布上限`;
}

export function invalidateAccountPublishQuotas(accountIds = []) {
  (accountIds || []).forEach(accountId => cache.delete(String(accountId || "")));
}

function announceQuotaChange(accountIds) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  if (typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent("xingzhen:account-publish-quotas", {
      detail: { accountIds: [...accountIds] }
    }));
  }
}

export async function refreshAccountPublishQuotas(accountIds = [], { force = false } = {}) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  if (!ids.length || !remote.isOn() || !remote.hasToken()) return false;
  const now = Date.now();
  const needed = ids.filter(id => force || !cache.get(id) || now - Number(cache.get(id).fetchedAt || 0) >= CACHE_TTL_MS);
  if (!needed.length) return false;
  const key = [...needed].sort().join(",");
  if (inflight.has(key)) return inflight.get(key);
  const task = remote.accountPublishQuotas(needed).then(result => {
    if (!result) return false;
    const before = needed.map(id => JSON.stringify(accountPublishQuota(id))).join("|");
    const byId = new Map((result.items || []).map(item => [String(item.accountId), item]));
    needed.forEach(id => {
      const item = byId.get(id) || { used: 0, remaining: Number(result.limit || ACCOUNT_DAILY_PUBLISH_LIMIT) };
      cache.set(id, {
        dayKey: String(result.dayKey || chinaDayKey()),
        limit: Number(result.limit || ACCOUNT_DAILY_PUBLISH_LIMIT),
        used: Number(item.used || 0),
        remaining: Number(item.remaining || 0),
        authoritative: true,
        fetchedAt: Date.now(),
      });
    });
    const changed = before !== needed.map(id => JSON.stringify(accountPublishQuota(id))).join("|");
    if (changed) announceQuotaChange(needed);
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
