/* 中央状态：单一数据源 + 事件总线 + 分集合持久化 */

import { db } from "./db.js";
import { debounce, sanitizeProduct, uid } from "./util.js";
import * as remote from "./remote.js";
import { mergeProductCatalog, PRODUCT_CATALOG_VERSION } from "../data/productCatalogSeed.js";

const DEFAULT_ADMIN_USERNAME = String.fromCharCode(97, 100, 109, 105, 110);
const LEGACY_ADMIN_USERNAME = String.fromCharCode(121, 117, 120, 117, 97, 110);
const DEFAULT_SUPPLIER_USERNAME = String.fromCharCode(103, 111, 110, 103, 121, 105, 110, 103, 115, 104, 97, 110, 103);
const DEFAULT_ADMIN_PIN_HASH = "pbkdf2$120000$737461722d61727261792d61646d696e2d7631$1d5f7e973e925fb41415dd6b322a3e8d6e3ab272e0c8ce8961393abd9af8edba";
const DEFAULT_SUPPLIER_PIN_HASH = "pbkdf2$120000$737461722d61727261792d737570706c6965722d7631$a5b6620381cff96c4602112ab5b3ee89b027d53c263d4452150cc9c7d9d5e1ff";

export const state = {
  role: null,                 // 当前登录成员的角色：admin | editor | supplier_parent | supplier_child
  members: [],                // 成员账号（将来服务器侧用户表的本地形态）
  accounts: [],
  productions: [],
  assets: [],
  sessions: [],
  batches: [],
  jobs: [],
  notifications: [],
  analyticsLinks: [],
  metricSnapshots: [],
  insightReports: [],
  creativeMemory: [],
  products: [],
  voicePresets: [],
  apiKeys: [],                // 存于 meta
  ui: {
    activeAccountId: null,
    activeProductionId: null,
    activeSessionId: null,
    currentMemberId: null,    // 当前登录成员
    autoAdvance: true,
    collapsedGroups: [],
    assetSeq: 0,              // 全局上传素材编号计数器（按上传先后递增）
    deliverSeq: 0,            // 全局发布序号计数器（按定稿发布先后递增，供应商端共享排序）
    returnTo: null            // 从看板/清单进工作台微调时的来处路由，给"返回"按钮用
  }
};

/* 权限（简化版，去掉审核员）：
   admin    管账号/成员/设置；创作链路只看本人，管理视图可看全局已发布/共享数据
   editor   创作成员：走创作流程，且可直接定稿发布入供应商端（拥有发布权）
   supplier_parent 供应商端管理员：管理子账号和内容账号分配
   supplier_child  供应商端子账号：仅处理被分配的发布清单 */
export const ROLE_LABEL = { admin: "管理员", editor: "创作成员", supplier: "供应商管理员", supplier_parent: "供应商管理员", supplier_child: "供应商子账号" };
export const currentMember = () => state.members.find(m => m.id === state.ui.currentMemberId) || null;
export const myId = () => state.ui.currentMemberId;
export const canManageAccounts = () => state.role === "admin";
export const canManageMembers = () => state.role === "admin";
export const canCreate = () => state.role === "admin" || state.role === "editor";
export const canDeliver = () => state.role === "admin" || state.role === "editor";   // 创作者也有发布权
export const canReview = canDeliver;                       // 兼容旧引用：现在"定稿"即由创作者自行完成
export const canMarkReviewed = () => state.role === "admin";  // 仅管理员可标注「已审阅」（非强制门槛）
export const canSeeAll = () => state.role === "admin";        // 仅管理员监管全量
export const isSupplierParent = () => state.role === "supplier_parent" || state.role === "supplier";
export const isSupplierChild = () => state.role === "supplier_child";
/* 创作互不干扰：单号创作、批量创作、草稿和会话都只看本人；旧数据无 owner 视为可见 */
export const ownedBy = (item) => !item?.ownerId || item.ownerId === state.ui.currentMemberId;

const listeners = {};
export function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); return () => off(evt, fn); }
export function off(evt, fn) { listeners[evt] = (listeners[evt] || []).filter(f => f !== fn); }
export function emit(evt, payload) { (listeners[evt] || []).forEach(f => { try { f(payload); } catch (e) { console.error("[store]", evt, e); } }); }

function defaultProducts() {
  return mergeProductCatalog([]);
}

async function ensureProductsSeed() {
  const before = JSON.stringify((state.products || []).map(p => ({ id: p.id, owner: p.owner, name: p.name, shortName: p.shortName, category: p.category })));
  state.products = state.products.length ? mergeProductCatalog(state.products) : defaultProducts();
  const after = JSON.stringify((state.products || []).map(p => ({ id: p.id, owner: p.owner, name: p.name, shortName: p.shortName, category: p.category })));
  const seeded = before !== after;
  const currentVersion = await db.metaGet("productCatalogVersion");
  if (seeded || currentVersion !== PRODUCT_CATALOG_VERSION) {
    await db.replaceAll("products", JSON.parse(JSON.stringify(state.products))).catch(() => null);
    await db.metaSet("products", JSON.parse(JSON.stringify(state.products))).catch(() => null);
    await db.metaSet("productCatalogVersion", PRODUCT_CATALOG_VERSION).catch(() => null);
    if (remote.isOn()) remote.putCollection("products", JSON.parse(JSON.stringify(state.products)));
  }
}

const PRODUCT_TERM_COLLECTIONS = [
  "accounts", "productions", "assets", "sessions", "batches", "jobs",
  "notifications", "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory", "voicePresets"
];
const PRODUCT_TERM_SKIP_KEYS = /(^id$|Id$|Ids$|_id$|url$|Url$|URL$|dataUrl$|token$|secret$|apiKey$|password$|pin$|endpoint$|provider$)/;

function normalizeProductTermsValue(value, key = "") {
  if (typeof value === "string") return PRODUCT_TERM_SKIP_KEYS.test(key) ? value : sanitizeProduct(value);
  if (Array.isArray(value)) return value.map(x => normalizeProductTermsValue(x, key));
  if (value && typeof value === "object") {
    let changed = false;
    const next = {};
    Object.entries(value).forEach(([k, v]) => {
      next[k] = normalizeProductTermsValue(v, k);
      if (next[k] !== v) changed = true;
    });
    return changed ? next : value;
  }
  return value;
}

async function normalizeProductTermsInState({ persistLocal = false, pushRemote = false } = {}) {
  const changed = [];
  PRODUCT_TERM_COLLECTIONS.forEach(c => {
    const before = JSON.stringify(state[c] || []);
    state[c] = normalizeProductTermsValue(state[c] || [], c);
    if (before !== JSON.stringify(state[c] || [])) changed.push(c);
  });
  if (persistLocal) {
    for (const c of changed) {
      try { await db.replaceAll(c, JSON.parse(JSON.stringify(state[c] || []))); } catch { /* ignore */ }
      if (pushRemote && remote.isOn()) remote.putCollection(c, JSON.parse(JSON.stringify(state[c] || [])));
    }
  }
  return changed;
}

/* ---- 持久化：标脏集合，防抖落盘 ---- */
const dirty = new Set();
const persist = debounce(async () => {
  const list = [...dirty]; dirty.clear();
  for (const c of list) {
    try {
      if (c === "meta") {
        await db.metaSet("apiKeys", JSON.parse(JSON.stringify(state.apiKeys)));
        await db.metaSet("ui", JSON.parse(JSON.stringify(state.ui)));
        await db.metaSet("role", state.role);
        await db.metaSet("products", JSON.parse(JSON.stringify(state.products)));
      } else {
        const snap = JSON.parse(JSON.stringify(state[c] || []));
        await db.replaceAll(c, snap);
        remote.putCollection(c, snap);   // 写穿透到共享后端（本地模式自动 no-op）
      }
    } catch (e) { console.warn("持久化失败", c, e); }
  }
}, 600);

export function save(...collections) {
  (collections.length ? collections : ["meta"]).forEach(c => dirty.add(c));
  persist();
  emit("change", { collections });
}

export async function persistNow() {
  const syncDirty = new Set(dirty);
  db.collections.forEach(c => dirty.add(c)); dirty.add("meta");
  const list = [...dirty]; dirty.clear();
  for (const c of list) {
    try {
      if (c === "meta") {
        await db.metaSet("apiKeys", JSON.parse(JSON.stringify(state.apiKeys)));
        await db.metaSet("ui", JSON.parse(JSON.stringify(state.ui)));
        await db.metaSet("role", state.role);
        await db.metaSet("members", JSON.parse(JSON.stringify(state.members)));
        await db.metaSet("products", JSON.parse(JSON.stringify(state.products)));
      } else {
        const snap = JSON.parse(JSON.stringify(state[c] || []));
        await db.replaceAll(c, snap);
        if (syncDirty.has(c)) remote.putCollection(c, snap);
      }
    } catch (e) { /* 静默 */ }
  }
}

/* ---- 启动装载 ---- */
export async function loadAll() {
  for (const c of db.collections) state[c] = await db.getAll(c);
  state.members = (await db.metaGet("members")) || [];
  const productMeta = (await db.metaGet("products")) || [];
  if (!state.products.length && productMeta.length) state.products = productMeta;
  state.apiKeys = (await db.metaGet("apiKeys")) || [];
  const ui = await db.metaGet("ui");
  if (ui) Object.assign(state.ui, ui);
  state.role = (await db.metaGet("role")) || null;
  if (state.role === "studio") state.role = "admin"; // 旧身份迁移
  if (state.role === "reviewer") state.role = "editor"; // 审核员已并入创作成员（含发布权）
  // 历史成员里的 reviewer 统一迁移为 editor
  let migrated = false;
  state.members.forEach(m => {
    if (m.role === "reviewer") { m.role = "editor"; migrated = true; }
    if (m.role === "supplier") { m.role = "supplier_parent"; migrated = true; }
  });
  state.members.forEach(m => {
    if (m.username === LEGACY_ADMIN_USERNAME && m.role === "admin") {
      m.username = DEFAULT_ADMIN_USERNAME;
      m.name = "管理员";
      delete m.pin;
      m.pinHash = DEFAULT_ADMIN_PIN_HASH;
      migrated = true;
    }
    if (m.username === DEFAULT_ADMIN_USERNAME && m.role === "admin" && m.pinHash !== DEFAULT_ADMIN_PIN_HASH) {
      m.name = "管理员";
      delete m.pin;
      m.pinHash = DEFAULT_ADMIN_PIN_HASH;
      migrated = true;
    }
  });
  if (migrated) db.metaSet("members", JSON.parse(JSON.stringify(state.members)));
  // 账号收敛 v2（一次性）：移除旧演示账号，落地正式管理员 / 供应商账号
  if (!(await db.metaGet("acctsV2"))) {
    const DEMO_USERNAMES = new Set(["reviewer", "editor", "supplier"]);
    state.members = state.members.filter(m => !DEMO_USERNAMES.has(m.username));
    if (!state.members.some(m => m.username === DEFAULT_ADMIN_USERNAME)) state.members.unshift({ id: uid(), name: "管理员", username: DEFAULT_ADMIN_USERNAME, pinHash: DEFAULT_ADMIN_PIN_HASH, role: "admin", createdAt: Date.now() });
    if (!state.members.some(m => m.username === DEFAULT_SUPPLIER_USERNAME)) state.members.push({ id: uid(), name: "供应商", username: DEFAULT_SUPPLIER_USERNAME, pinHash: DEFAULT_SUPPLIER_PIN_HASH, role: "supplier", createdAt: Date.now() });
    db.metaSet("members", JSON.parse(JSON.stringify(state.members)));
    db.metaSet("acctsV2", true);
  }
  // 兜底：成员为空也要有一个管理员
  if (!state.members.length) {
    state.members = [{ id: uid(), name: "管理员", username: DEFAULT_ADMIN_USERNAME, pinHash: DEFAULT_ADMIN_PIN_HASH, role: "admin", createdAt: Date.now() }];
    db.metaSet("members", JSON.parse(JSON.stringify(state.members)));
  }
  await ensureProductsSeed();
  await normalizeProductTermsInState({ persistLocal: true });
  if (Array.isArray(state.ui.customVoices) && state.ui.customVoices.length) {
    const existing = new Set((state.voicePresets || []).map(v => v.voiceId || v.id).filter(Boolean));
    const now = Date.now();
    const migrated = [];
    state.ui.customVoices.forEach(v => {
      const voiceId = String(v.voiceId || "").trim();
      if (!voiceId || existing.has(voiceId)) return;
      existing.add(voiceId);
      migrated.push({
        id: v.id || uid(),
        voiceId,
        name: v.name || voiceId,
        description: v.description || "",
        source: "mine",
        ownerId: state.ui.currentMemberId || "",
        createdAt: v.createdAt || now,
        updatedAt: v.updatedAt || v.createdAt || now,
        previewAudioDataUrl: v.previewAudioDataUrl || v.audioDataUrl || "",
      });
    });
    if (migrated.length) {
      state.voicePresets.unshift(...migrated);
      await db.replaceAll("voicePresets", JSON.parse(JSON.stringify(state.voicePresets)));
      if (remote.isOn()) remote.putCollection("voicePresets", JSON.parse(JSON.stringify(state.voicePresets)));
    }
    delete state.ui.customVoices;
    db.metaSet("ui", JSON.parse(JSON.stringify(state.ui)));
  }
  if (state.ui.assetSeq == null) state.ui.assetSeq = state.assets.filter(a => !a.delivered).length;
  // 发布序号回填：历史已发布资产补 pubSeq（按发布/创建先后），让发布清单「序号」有意义
  {
    const delivered = state.assets.filter(a => a.delivered);
    const need = delivered.filter(a => a.pubSeq == null)
      .sort((a, b) => (a.deliveredAt || a.createdAt || 0) - (b.deliveredAt || b.createdAt || 0));
    let seq = Math.max(state.ui.deliverSeq || 0, delivered.reduce((m, a) => Math.max(m, a.pubSeq || 0), 0));
    need.forEach(a => { a.pubSeq = ++seq; if (!a.deliveredAt) a.deliveredAt = a.createdAt; if (!a.byAccount) { const ac = accountById(a.accountId); a.byAccount = ac ? ac.name : ""; } });
    state.ui.deliverSeq = seq;
    if (need.length) db.replaceAll("assets", JSON.parse(JSON.stringify(state.assets)));
  }
  // 当前成员失效时清空（要求重新登录）
  if (state.ui.currentMemberId && !state.members.find(m => m.id === state.ui.currentMemberId)) {
    state.ui.currentMemberId = null; state.role = null;
  }
  // 排序约定
  state.notifications.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  state.sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function saveMembers() {
  db.metaSet("members", JSON.parse(JSON.stringify(state.members)));
  emit("change", { collections: ["members"] });
}

/* 删除同步到共享后端（本地删除后调用；远端关时 no-op）。写穿透只新增/更新，删除必须显式发。 */
export function removeRemote(collection, ...ids) {
  ids.forEach(id => remote.deleteDoc(collection, id).catch(e => console.warn("远端删除失败", collection, id, e)));
}

export async function removeRemoteAsync(collection, ...ids) {
  await Promise.all(ids.filter(id => id != null).map(id => remote.deleteDoc(collection, id)));
}

/* 登录后从服务端拉全量快照覆盖本地 + 回写 IndexedDB 缓存（离线可用）。
   共享模式下服务器是权威源：绝不把本机旧缓存当作 localOnly 回推。
   这样 A 删除账号/资产后，B 的旧 IndexedDB 不会在下次刷新时把它复活。
   离线/纯本地模式不进入这里，仍保留本地数据。 */
export async function pullRemote() {
  if (!remote.isOn() || !remote.hasToken()) return false;
  let snap;
  try { snap = await remote.getState(); } catch { return false; }
  for (const c of db.collections) {
    if (!Array.isArray(snap[c])) continue;        // 服务器没返回该集合（如 notifications）→ 本地保持不动
    state[c] = JSON.parse(JSON.stringify(snap[c] || []));
  }
  if (Array.isArray(snap.members)) state.members = snap.members;
  for (const c of db.collections) {
    if (!Array.isArray(snap[c])) continue;
    try { await db.replaceAll(c, JSON.parse(JSON.stringify(state[c] || []))); } catch (e) { /* 缓存失败不致命 */ }
  }
  const supplierReadOnly = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  if (!supplierReadOnly) {
    await ensureProductsSeed();
    await normalizeProductTermsInState({ persistLocal: true, pushRemote: true });
    if (Array.isArray(snap.products) && !snap.products.length) remote.putCollection("products", state.products);
  }
  if (Array.isArray(snap.members)) db.metaSet("members", JSON.parse(JSON.stringify(state.members)));
  state.notifications.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  state.sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  emit("change", { collections: db.collections });
  return true;
}

/* ---- 通知中心 ---- */
export function notify(kind, title, body = "", meta = {}) {
  state.notifications.unshift({ id: uid(), ts: Date.now(), kind, title, body, read: false, ...meta });
  if (state.notifications.length > 60) state.notifications.length = 60;
  save("notifications");
  emit("notify");
}

/* ---- 快捷取值 ---- */
export const accountById = id => state.accounts.find(a => a.id === id);
export const productById = id => state.products.find(p => p.id === id) || state.products[0] || null;
export const primaryProducts = () => {
  const ours = state.products.filter(p => p.owner === "ours");
  return ours.length ? ours : state.products.filter(p => ["dumate", "miaoda"].includes(p.id));
};
export const primaryProductById = id => primaryProducts().find(p => p.id === id) || primaryProducts()[0] || productById(id);
export const productionById = id => state.productions.find(p => p.id === id);
export const assetById = id => state.assets.find(a => a.id === id);
export const activeAccount = () => accountById(state.ui.activeAccountId) || state.accounts[0] || null;
export const activeProduction = () => {
  const p = productionById(state.ui.activeProductionId);
  return p && ownedBy(p) ? p : null;
};
