/* 共享后端客户端（Phase 1）：登录态 + 全量拉取 + 写穿透 + 成员管理。
   仅当应用由 FastAPI 服务端托管（探测 /api/health 通过）时启用；
   否则保持纯本地模式（serve.mjs 预览 / 离线），所有写操作自动 no-op，零影响。 */

const TOKEN_KEY = "dumate.token";
let _on = false;                                   // 是否处于服务端共享模式
let _token = localStorage.getItem(TOKEN_KEY) || "";
let _authBlocked = false;
const FETCH_TIMEOUT_MS = 9000;

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
  if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
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

async function req(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache" };
  if (auth && _token) headers.Authorization = "Bearer " + _token;
  let res;
  try {
    res = await fetchWithTimeout(path, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error((e && e.name === "AbortError") ? "请求超时，请检查本地服务端" : (e.message || String(e)));
  }
  if (res.status === 401) { _authBlocked = true; setToken(""); throw new Error("登录已过期，请重新登录"); }
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 160));
  return res.status === 204 ? null : res.json();
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
  const r = await req("/api/auth/login", { method: "POST", auth: false, body: { username, pin } });
  setToken(r.token);
  return r.member;
}
export async function me() {
  if (!_token) return null;
  try { return await req("/api/auth/me"); } catch { return null; }
}
export function logout() { setToken(""); }

export function getState() { return req("/api/state"); }

export function requestMember(payload) {
  return req("/api/member-requests", { method: "POST", auth: false, body: payload });
}

/* 写穿透：整集合 upsert（服务端按 id 后写胜，绝不整表删）。关时/未登录时 no-op。 */
export function putCollection(name, items) {
  if (!_on || !_token || _authBlocked || !SYNCED.has(name)) return Promise.resolve();
  return req("/api/db/" + name, { method: "PUT", body: { items: items || [] } }).catch(() => {});
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

export const memberRequests = {
  list: (status = "pending") => req("/api/member-requests" + (status ? "?status=" + encodeURIComponent(status) : "")),
  approve: (id) => req("/api/member-requests/" + encodeURIComponent(id) + "/approve", { method: "POST" }),
  reject: (id) => req("/api/member-requests/" + encodeURIComponent(id) + "/reject", { method: "POST" })
};

/* 供应商母账号：子账号、内容账号绑定与操作记录均由服务端授权。 */
export const supplier = {
  children: () => req("/api/supplier/children"),
  addChildren: (items) => req("/api/supplier/children", { method: "POST", body: { items } }),
  updateChild: (id, data) => req("/api/supplier/children/" + encodeURIComponent(id), { method: "PUT", body: data }),
  removeChild: (id) => req("/api/supplier/children/" + encodeURIComponent(id), { method: "DELETE" }),
  bindings: () => req("/api/supplier/bindings"),
  bindAccounts: (id, accountIds) => req("/api/supplier/children/" + encodeURIComponent(id) + "/accounts", { method: "PUT", body: { accountIds } }),
  activity: () => req("/api/supplier/activity"),
  record: (data) => req("/api/supplier/activity", { method: "POST", body: data }),
  updateViews: (assetId, viewCount) => req("/api/supplier/assets/" + encodeURIComponent(assetId) + "/views", { method: "PUT", body: { viewCount } })
};
