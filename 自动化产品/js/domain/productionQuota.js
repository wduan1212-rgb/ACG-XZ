import { state } from "../core/store.js";
import * as remote from "../core/remote.js";

export const ACCOUNT_DAILY_CREATION_LIMIT = 2;

const cache = new Map();
const inflight = new Map();
const CACHE_TTL_MS = 30_000;

function chinaDayKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(Number(timestamp) || Date.now()));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function productionDayKey(production = {}) {
  const stamped = String(production.quotaDayKey || "");
  if (stamped) return stamped;
  const createdAt = Number(production.quotaCreatedAt || production.createdAt || 0);
  return createdAt > 0 ? chinaDayKey(createdAt) : "";
}

function localUsed(accountId) {
  const today = chinaDayKey();
  const productionCount = state.productions.filter(production => (
    String(production?.accountId || "") === String(accountId || "")
    && productionDayKey(production) === today
  )).length;
  const customDeliveryCount = state.assets.filter(asset => (
    String(asset?.accountId || "") === String(accountId || "")
    && asset?.delivered
    && asset?.customProjectId
    && productionDayKey({
      quotaDayKey: asset.quotaDayKey,
      quotaCreatedAt: asset.quotaCreatedAt,
      createdAt: asset.deliveredAt || asset.createdAt,
    }) === today
  )).length;
  return productionCount + customDeliveryCount;
}

export function accountCreationQuota(accountId) {
  const id = String(accountId || "");
  const local = localUsed(id);
  const stored = cache.get(id);
  const current = stored?.dayKey === chinaDayKey() ? Number(stored.used || 0) : 0;
  const used = Math.max(0, local, current);
  const limit = Math.max(1, Number(stored?.limit || ACCOUNT_DAILY_CREATION_LIMIT));
  return {
    accountId: id,
    dayKey: chinaDayKey(),
    used,
    limit,
    remaining: Math.max(0, limit - used),
    authoritative: Boolean(stored?.authoritative),
  };
}

export function accountCreationAvailable(accountId, requested = 1) {
  return accountCreationQuota(accountId).remaining >= Math.max(1, Number(requested) || 1);
}

export function quotaExceededMessage(accountIds = []) {
  const names = [...new Set((accountIds || []).map(id => (
    state.accounts.find(account => String(account.id) === String(id))?.name || String(id)
  )))].slice(0, 3);
  return `${names.join("、")}${accountIds.length > 3 ? "等账号" : ""}今日已达每个账号 ${ACCOUNT_DAILY_CREATION_LIMIT} 条的创作上限`;
}

export function validateAccountCreationRequests(items = []) {
  const requested = new Map();
  (items || []).forEach(item => {
    const accountId = String(item?.accountId || "");
    if (accountId) requested.set(accountId, (requested.get(accountId) || 0) + 1);
  });
  const exceeded = [...requested].filter(([accountId, count]) => (
    !accountCreationAvailable(accountId, count)
  )).map(([accountId]) => accountId);
  if (exceeded.length) throw new Error(quotaExceededMessage(exceeded));
}

export function invalidateAccountCreationQuotas(accountIds = []) {
  (accountIds || []).forEach(accountId => cache.delete(String(accountId || "")));
}

export async function refreshAccountCreationQuotas(accountIds = [], { force = false } = {}) {
  const ids = [...new Set((accountIds || []).map(String).filter(Boolean))];
  if (!ids.length || !remote.isOn() || !remote.hasToken()) return false;
  const now = Date.now();
  const needed = ids.filter(id => force || !cache.get(id) || now - Number(cache.get(id).fetchedAt || 0) >= CACHE_TTL_MS);
  if (!needed.length) return false;
  const key = [...needed].sort().join(",");
  if (inflight.has(key)) return inflight.get(key);
  const task = remote.accountCreationQuotas(needed).then(result => {
    if (!result) return false;
    const before = needed.map(id => JSON.stringify(accountCreationQuota(id))).join("|");
    const byId = new Map((result.items || []).map(item => [String(item.accountId), item]));
    needed.forEach(id => {
      const item = byId.get(id) || { used: 0, remaining: Number(result.limit || ACCOUNT_DAILY_CREATION_LIMIT) };
      cache.set(id, {
        dayKey: String(result.dayKey || chinaDayKey()),
        limit: Number(result.limit || ACCOUNT_DAILY_CREATION_LIMIT),
        used: Number(item.used || 0),
        remaining: Number(item.remaining || 0),
        authoritative: true,
        fetchedAt: Date.now(),
      });
    });
    return before !== needed.map(id => JSON.stringify(accountCreationQuota(id))).join("|");
  }).catch(error => {
    console.warn("创作配额同步失败", error);
    return false;
  }).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
