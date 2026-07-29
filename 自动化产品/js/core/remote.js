/* 共享后端客户端（Phase 1）：登录态 + 全量拉取 + 写穿透 + 成员管理。
   仅当应用由 FastAPI 服务端托管（探测 /api/health 通过）时启用；
   否则保持纯本地模式（serve.mjs 预览 / 离线），所有写操作自动 no-op，零影响。 */

const TOKEN_KEY = "dumate.token";
const tokenStorage = typeof localStorage !== "undefined"
  ? localStorage
  : { getItem() { return ""; }, setItem() {}, removeItem() {} };
let _on = false;                                   // 是否处于服务端共享模式
let _token = tokenStorage.getItem(TOKEN_KEY) || "";
let _authBlocked = false;
const _collectionSyncHolds = new Map();
const _heldCollectionSnapshots = new Map();
const FETCH_TIMEOUT_MS = 9000;
const PERFORMANCE_KEY = "xingzhen.remote.performance.v1";
const LOCAL_PUBLISH_TAGS_KEY = "xingzhen.publish-tags.v1";
const PERFORMANCE_DETAIL_KEYS = new Set([
  "durationMs", "ttfbMs", "bodyMs", "parseMs", "bodyChars", "status",
  "collections", "collectionCount", "phase", "source", "ok"
]);

/* 与服务端 store.COLLECTIONS 对齐：notifications/ui/apiKeys 是本地态，不入服务器 */
export const SYNCED = new Set([
  "accounts", "productions", "assets", "sessions", "batches", "jobs",
  "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory", "products", "voicePresets"
]);

export const isOn = () => _on;
export const hasToken = () => !!_token;
export const getToken = () => _token;
export function setToken(t) {
  _token = t || "";
  if (t) _authBlocked = false;
  if (t) tokenStorage.setItem(TOKEN_KEY, t); else tokenStorage.removeItem(TOKEN_KEY);
}

function perfNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/* 只记录耗时、集合名和数量，不记录用户名、token、请求体或业务数据。 */
export function recordPerformance(stage, detail = {}) {
  const safeDetail = {};
  Object.entries(detail || {}).forEach(([key, value]) => {
    if (!PERFORMANCE_DETAIL_KEYS.has(key)) return;
    if (Array.isArray(value)) {
      safeDetail[key] = value.map(item => String(item || "").slice(0, 40)).slice(0, 20);
    } else if (["string", "number", "boolean"].includes(typeof value)) {
      safeDetail[key] = typeof value === "string" ? value.slice(0, 80) : value;
    }
  });
  const entry = { stage: String(stage || "unknown").slice(0, 60), at: Date.now(), ...safeDetail };
  try {
    const previous = JSON.parse(sessionStorage.getItem(PERFORMANCE_KEY) || "[]");
    const rows = Array.isArray(previous) ? previous.slice(-79) : [];
    rows.push(entry);
    sessionStorage.setItem(PERFORMANCE_KEY, JSON.stringify(rows));
  } catch (_) {}
  if (typeof window !== "undefined") {
    window.__xingzhenRemotePerformance = [
      ...(Array.isArray(window.__xingzhenRemotePerformance) ? window.__xingzhenRemotePerformance.slice(-79) : []),
      entry
    ];
    if (typeof CustomEvent === "function" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("xingzhen:remote-performance", { detail: entry }));
    }
  }
  console.debug("[remote-performance]", entry);
  return entry;
}

async function fetchWithTimeout(path, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(path, { cache: "no-store", ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function req(path, { method = "GET", body, auth = true, metric = "", metricDetail = {} } = {}) {
  const startedAt = perfNow();
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache" };
  if (auth && _token) headers.Authorization = "Bearer " + _token;
  let res;
  try {
    res = await fetchWithTimeout(path, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  } catch (e) {
    if (metric) recordPerformance(metric, {
      ...metricDetail,
      durationMs: Math.max(0, Math.round(perfNow() - startedAt)),
      ok: false
    });
    throw new Error((e && e.name === "AbortError") ? "请求超时，请检查本地服务端" : (e.message || String(e)));
  }
  const ttfbMs = Math.max(0, perfNow() - startedAt);
  if (res.status === 401) {
    if (metric) recordPerformance(metric, {
      ...metricDetail,
      durationMs: Math.max(0, Math.round(perfNow() - startedAt)),
      ttfbMs: Math.round(ttfbMs),
      status: res.status,
      ok: false
    });
    _authBlocked = true;
    setToken("");
    const error = new Error("HTTP 401 登录已过期，请重新登录");
    error.status = 401;
    throw error;
  }
  if (!res.ok) {
    if (metric) recordPerformance(metric, {
      ...metricDetail,
      durationMs: Math.max(0, Math.round(perfNow() - startedAt)),
      ttfbMs: Math.round(ttfbMs),
      status: res.status,
      ok: false
    });
    const error = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 160));
    error.status = res.status;
    throw error;
  }
  if (res.status === 204) {
    if (metric) recordPerformance(metric, {
      ...metricDetail,
      durationMs: Math.max(0, Math.round(perfNow() - startedAt)),
      ttfbMs: Math.round(ttfbMs),
      status: res.status,
      ok: true
    });
    return null;
  }
  if (!metric) return res.json();
  const bodyStartedAt = perfNow();
  const text = await res.text();
  const bodyMs = Math.max(0, perfNow() - bodyStartedAt);
  const parseStartedAt = perfNow();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (error) {
    recordPerformance(metric, {
      ...metricDetail,
      durationMs: Math.max(0, Math.round(perfNow() - startedAt)),
      ttfbMs: Math.round(ttfbMs),
      bodyMs: Math.round(bodyMs),
      bodyChars: text.length,
      status: res.status,
      ok: false
    });
    throw error;
  }
  recordPerformance(metric, {
    ...metricDetail,
    durationMs: Math.max(0, Math.round(perfNow() - startedAt)),
    ttfbMs: Math.round(ttfbMs),
    bodyMs: Math.round(bodyMs),
    parseMs: Math.max(0, Math.round(perfNow() - parseStartedAt)),
    bodyChars: text.length,
    status: res.status,
    ok: true
  });
  return parsed;
}

/* 启动探测：应用是否由共享后端托管 */
export async function init() {
  try {
    const r = await fetchWithTimeout("/api/health", {}, 3000);
    _on = r.ok && (await r.json()).ok === true;
  } catch { _on = false; }
  return _on;
}

export async function login(username, pin) {
  const r = await req("/api/auth/login", {
    method: "POST",
    auth: false,
    body: { username, pin },
    metric: "auth"
  });
  setToken(r.token);
  return r.member;
}
export async function me() {
  if (!_token) return null;
  try { return await req("/api/auth/me", { metric: "auth-resume" }); } catch { return null; }
}
export function logout() { setToken(""); }

export function getState(collections = []) {
  const allowed = new Set(["members", ...SYNCED]);
  const names = [...new Set(
    (Array.isArray(collections) ? collections : [])
      .map(name => String(name || "").trim())
      .filter(name => allowed.has(name))
  )];
  const query = names.length
    ? `?collections=${encodeURIComponent(names.join(","))}`
    : "";
  return req(`/api/state${query}`, {
    metric: "state",
    metricDetail: {
      phase: names.length ? "partial" : "full",
      collections: names,
      collectionCount: names.length
    }
  });
}

export function requestMember(payload) {
  return req("/api/member-requests", { method: "POST", auth: false, body: payload });
}

export const passwordReset = {
  request: (name) => req("/api/password-reset-requests", {
    method: "POST",
    auth: false,
    body: { name }
  }),
  list: () => req("/api/password-reset-requests")
};

function localPublishTags() {
  try {
    const rows = JSON.parse(tokenStorage.getItem(LOCAL_PUBLISH_TAGS_KEY) || "[]");
    return Array.isArray(rows) ? rows.filter(item => item?.label) : [];
  } catch (_) {
    return [];
  }
}

export const publishTags = {
  async list() {
    if (_on && _token && !_authBlocked) return req("/api/publish-tags");
    return { items: localPublishTags() };
  },
  async create(label) {
    const clean = String(label || "").trim().replace(/\s+/g, " ").slice(0, 20);
    if (!clean) throw new Error("标签不能为空");
    if (_on && _token && !_authBlocked) {
      return req("/api/publish-tags", { method: "POST", body: { label: clean } });
    }
    const rows = localPublishTags();
    const existing = rows.find(item => String(item.label).toLocaleLowerCase() === clean.toLocaleLowerCase());
    if (existing) return { item: existing };
    const item = { id: `local-publish-tag-${Date.now().toString(36)}`, label: clean };
    tokenStorage.setItem(LOCAL_PUBLISH_TAGS_KEY, JSON.stringify([...rows, item]));
    return { item };
  }
};

/* 写穿透：整集合 upsert（服务端按 id 后写胜，绝不整表删）。关时/未登录时 no-op。 */
export function putCollection(name, items) {
  if (!_on || !_token || _authBlocked || !SYNCED.has(name)) return Promise.resolve();
  if ((_collectionSyncHolds.get(name) || 0) > 0) {
    _heldCollectionSnapshots.set(name, JSON.parse(JSON.stringify(items || [])));
    return Promise.resolve();
  }
  return req("/api/db/" + name, { method: "PUT", body: { items: items || [] } }).catch(() => {});
}
/* 语义化别名：服务端 PUT 是按 id upsert，可安全发送单文档或小批量，
   调用方无需为了一个轮询进度回推整个集合。 */
export function putDocuments(name, items) {
  return putCollection(name, items);
}
export function holdCollectionSync(collections = [...SYNCED]) {
  const names = [...new Set((collections || []).filter(name => SYNCED.has(name)))];
  names.forEach(name => {
    _collectionSyncHolds.set(name, (_collectionSyncHolds.get(name) || 0) + 1);
  });
  let released = false;
  return ({ flush = true } = {}) => {
    if (released) return;
    released = true;
    names.forEach(name => {
      const next = Math.max(0, (_collectionSyncHolds.get(name) || 0) - 1);
      if (next) {
        _collectionSyncHolds.set(name, next);
        return;
      }
      _collectionSyncHolds.delete(name);
      const snapshot = _heldCollectionSnapshots.get(name);
      _heldCollectionSnapshots.delete(name);
      if (flush && snapshot) putCollection(name, snapshot);
    });
  };
}
/* 关键提交使用显式同步：错误交给调用方展示，不能像普通后台写穿透一样静默吞掉。 */
export function syncCollection(name, items) {
  if (!_on || !_token || _authBlocked) return Promise.reject(new Error("服务器登录已失效"));
  if (!SYNCED.has(name)) return Promise.reject(new Error("该数据集合不允许同步"));
  return req("/api/db/" + name, { method: "PUT", body: { items: items || [] } });
}
export function deleteDoc(name, id) {
  if (!_on || !_token || _authBlocked || !SYNCED.has(name) || id == null) return Promise.resolve();
  return req("/api/db/" + name + "/" + encodeURIComponent(id), { method: "DELETE" });
}

/* 成员管理（admin）：口令在服务端哈希存储 */
export const members = {
  list: (fresh = false) => req("/api/members" + (fresh ? "?ts=" + Date.now() : "")),
  add: (m) => req("/api/members", { method: "POST", body: m }),
  update: (id, m) => req("/api/members/" + id, { method: "PUT", body: m }),
  remove: (id) => req("/api/members/" + id, { method: "DELETE" })
};

export const memberProfile = {
  get: () => req("/api/members/me"),
  update: (profile) => req("/api/members/me", { method: "PUT", body: profile }),
  async uploadAvatar(file) {
    if (!_on || !_token) throw new Error("服务器登录已失效");
    const type = String(file?.type || "").toLowerCase();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(type)) throw new Error("头像仅支持 PNG、JPG、WebP 或 GIF");
    if (Number(file?.size || 0) > 2 * 1024 * 1024) throw new Error("头像请控制在 2MB 以内");
    const query = new URLSearchParams({ filename: String(file?.name || "avatar"), mime: type });
    const res = await fetchWithTimeout("/api/members/me/avatar?" + query.toString(), {
      method: "PUT",
      headers: { "Content-Type": type, "Authorization": "Bearer " + _token, "Cache-Control": "no-cache" },
      body: file,
    });
    if (!res.ok) {
      let message = "头像上传失败";
      try { message = (await res.json()).detail || message; } catch (_) {}
      throw new Error(`HTTP ${res.status} ${message}`);
    }
    return res.json();
  }
};

export const memberRequests = {
  list: (status = "pending") => req("/api/member-requests" + (status ? "?status=" + encodeURIComponent(status) : "")),
  approve: (id) => req("/api/member-requests/" + encodeURIComponent(id) + "/approve", { method: "POST" }),
  reject: (id) => req("/api/member-requests/" + encodeURIComponent(id) + "/reject", { method: "POST" })
};

/* 管理员用量看板：语言 Token 与实际图片/视频调用分账展示。 */
export const admin = {
  llmUsage: () => req("/api/admin/llm-usage"),
  llmUsageDetails: (memberId = "") => req("/api/admin/llm-usage/details" + (memberId ? "?memberId=" + encodeURIComponent(memberId) : ""))
};

/* 供应商母账号：子账号、内容账号绑定与操作记录均由服务端授权。 */
export const supplier = {
  members: () => req("/api/supplier/members"),
  children: () => req("/api/supplier/children"),
  addChildren: (items) => req("/api/supplier/children", { method: "POST", body: { items } }),
  updateChild: (id, data) => req("/api/supplier/children/" + encodeURIComponent(id), { method: "PUT", body: data }),
  updateMember: (id, data) => req("/api/supplier/members/" + encodeURIComponent(id), { method: "PUT", body: data }),
  removeChild: (id) => req("/api/supplier/children/" + encodeURIComponent(id), { method: "DELETE" }),
  bindings: () => req("/api/supplier/bindings"),
  bindAccounts: (id, accountIds) => req("/api/supplier/children/" + encodeURIComponent(id) + "/accounts", { method: "PUT", body: { accountIds } }),
  activity: () => req("/api/supplier/activity"),
  record: (data) => req("/api/supplier/activity", { method: "POST", body: data }),
  updateViews: (assetId, viewCount) => req("/api/supplier/assets/" + encodeURIComponent(assetId) + "/views", { method: "PUT", body: { viewCount } }),
  updateExposure: (assetId, exposureCount) => req("/api/supplier/assets/" + encodeURIComponent(assetId) + "/exposure", { method: "PUT", body: { exposureCount } }),
  updateAccountViews: (accountId, viewCount) => req("/api/supplier/accounts/" + encodeURIComponent(accountId) + "/views", { method: "PUT", body: { viewCount } }),
  markDownloaded: (assetId) => req("/api/supplier/assets/" + encodeURIComponent(assetId) + "/downloaded", { method: "PUT" }),
  returnLink: (assetId, data) => req("/api/supplier/assets/" + encodeURIComponent(assetId) + "/published-link", { method: "PUT", body: data }),
  ask: (question) => req("/api/supplier/assistant", { method: "POST", body: { question }, metric: "supplier-assistant" }),
  updateHomepage: (accountId, homepageUrl) => req("/api/supplier/accounts/" + encodeURIComponent(accountId) + "/homepage", { method: "PUT", body: { homepageUrl } }),
  createAccount: (account, assets = []) => req("/api/supplier/accounts", { method: "POST", body: { account, assets } }),
  updateAccount: (accountId, account, assets = []) => req("/api/supplier/accounts/" + encodeURIComponent(accountId), { method: "PUT", body: { account, assets } })
};

export const deliveryRemarks = {
  list: (assetId) => req("/api/deliveries/" + encodeURIComponent(assetId) + "/remarks"),
  add: (assetId, text) => req("/api/deliveries/" + encodeURIComponent(assetId) + "/remarks", { method: "POST", body: { text } }),
  read: (assetId) => req("/api/deliveries/" + encodeURIComponent(assetId) + "/remarks/read", { method: "PUT" })
};

/* 定制创作项目使用专用 owner-scoped API，不进入 /api/state 的整集合写穿透。 */
export const customProjects = {
  list: (kind = "") => req("/api/custom-projects" + (kind ? "?kind=" + encodeURIComponent(kind) : "")),
  get: (id) => req("/api/custom-projects/" + encodeURIComponent(id)),
  create: (payload) => req("/api/custom-projects", { method: "POST", body: payload }),
  update: (id, payload) => req("/api/custom-projects/" + encodeURIComponent(id), { method: "PUT", body: payload }),
  publish: (id, payload) => req("/api/custom-projects/" + encodeURIComponent(id) + "/publish", {
    method: "POST",
    body: typeof payload === "string" ? { deliveryId: payload } : payload
  }),
  unpublish: (id, deliveryId) => req("/api/custom-projects/" + encodeURIComponent(id) + "/unpublish", {
    method: "POST",
    body: { deliveryId }
  }),
  remove: (id) => req("/api/custom-projects/" + encodeURIComponent(id), { method: "DELETE" })
};

/* 无限画布项目：复用 owner-scoped 草稿接口，供统一工作区读取、重命名与删除。 */
export const customCanvasProjects = {
  list: () => req("/api/custom-canvas/projects"),
  get: (id) => req("/api/custom-canvas/projects/" + encodeURIComponent(id)),
  update: (id, payload) => req("/api/custom-canvas/projects/" + encodeURIComponent(id), {
    method: "PUT",
    body: payload
  }),
  remove: (id) => req("/api/custom-canvas/projects/" + encodeURIComponent(id), {
    method: "DELETE"
  })
};
