/* 中央状态：单一数据源 + 事件总线 + 分集合持久化 */

import { db } from "./db.js";
import { debounce, sanitizeProduct, uid } from "./util.js";
import * as remote from "./remote.js";
import { mergeProductCatalog, PRODUCT_CATALOG_VERSION } from "../data/productCatalogSeed.js?v=20260813-v1431-creation-queue-stability-1";
import { normalizeLegacyInputFallbackState } from "../domain/productionFailureState.js?v=20260813-v1431-creation-queue-stability-1";

const DEFAULT_ADMIN_USERNAME = String.fromCharCode(97, 100, 109, 105, 110);
const LEGACY_ADMIN_USERNAME = String.fromCharCode(121, 117, 120, 117, 97, 110);
const DEFAULT_SUPPLIER_USERNAME = String.fromCharCode(103, 111, 110, 103, 121, 105, 110, 103, 115, 104, 97, 110, 103);
const DEFAULT_ADMIN_PIN_HASH = "pbkdf2$120000$737461722d61727261792d61646d696e2d7631$1d5f7e973e925fb41415dd6b322a3e8d6e3ab272e0c8ce8961393abd9af8edba";
const DEFAULT_SUPPLIER_PIN_HASH = "pbkdf2$120000$737461722d61727261792d737570706c6965722d7631$a5b6620381cff96c4602112ab5b3ee89b027d53c263d4452150cc9c7d9d5e1ff";

export const state = {
  role: null,                 // 当前身份：admin | editor | user | supplier_parent | supplier_child | guest
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
export const ROLE_LABEL = { admin: "管理员", editor: "创作成员", user: "个人用户", guest: "游客", supplier: "供应商管理员", supplier_parent: "供应商管理员", supplier_child: "供应商子账号" };
export const currentMember = () => state.members.find(m => m.id === state.ui.currentMemberId) || null;
export const myId = () => state.ui.currentMemberId;
export const currentTeam = () => currentMember()?.team || null;
export const hasEntitlement = (key) => {
  const member = currentMember();
  if (!key || ["admin", "editor"].includes(state.role) && !Array.isArray(member?.entitlements)) return true;
  return Array.isArray(member?.entitlements) && member.entitlements.includes(key);
};
export const canManageAccounts = () => hasEntitlement("team_members") && ["owner", "admin"].includes(currentMember()?.teamRole);
export const canManageMembers = canManageAccounts;
export const canCreate = () => ["admin", "editor", "user"].includes(state.role);
export const canDeliver = () => {
  const member = currentMember();
  const teamAccess = Boolean(member?.team?.id || member?.team?.name);
  const plan = String(member?.plan || member?.subscription || "").toLowerCase();
  const professional = ["pro", "professional", "team"].includes(plan)
    || (
      Array.isArray(member?.entitlements)
      && member.entitlements.some(key => ["publish", "delivery", "professional"].includes(key))
    );
  return teamAccess || professional;
};
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
/* 共享但按条授权的集合不能走普通整集合后台回推。
   voicePresets 的新增/改名/删除由 domain/voices.js 显式等待服务端确认，
   避免成员 A 的旧快照覆盖或阻断成员 B 已更新的共享音色。 */
const EXPLICIT_REMOTE_COLLECTIONS = new Set(["voicePresets"]);
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
      if (pushRemote && remote.isOn() && !EXPLICIT_REMOTE_COLLECTIONS.has(c)) {
        remote.putCollection(c, JSON.parse(JSON.stringify(state[c] || [])));
      }
    }
  }
  return changed;
}

/* ---- 持久化：标脏集合，防抖落盘 ---- */
const dirty = new Set();
const incrementalDirty = new Map();
let incrementalTimer = 0;
async function flushIncremental() {
  if (incrementalTimer) {
    globalThis.clearTimeout(incrementalTimer);
    incrementalTimer = 0;
  }
  const batches = [...incrementalDirty.entries()];
  incrementalDirty.clear();
  for (const [collection, docs] of batches) {
    const items = [...docs.values()].map(item => JSON.parse(JSON.stringify(item)));
    if (!items.length) continue;
    try {
      await db.putMany(collection, items);
      if (!EXPLICIT_REMOTE_COLLECTIONS.has(collection)) remote.putDocuments(collection, items);
    } catch (e) {
      console.warn("增量持久化失败", collection, e);
    }
  }
}

/* Job 轮询等高频状态只合并变化文档；同一文档在 700ms 窗口内只写最后状态。 */
export function saveIncremental(collection, ...items) {
  if (!db.collections.includes(collection)) return;
  const docs = incrementalDirty.get(collection) || new Map();
  items.flat().filter(item => item?.id).forEach(item => docs.set(String(item.id), item));
  incrementalDirty.set(collection, docs);
  if (typeof globalThis.setTimeout === "function") {
    if (incrementalTimer) globalThis.clearTimeout(incrementalTimer);
    incrementalTimer = globalThis.setTimeout(flushIncremental, 700);
  } else {
    void flushIncremental();
  }
  emit("change", { collections: [collection], incremental: true });
}
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
        if (!EXPLICIT_REMOTE_COLLECTIONS.has(c)) {
          remote.putCollection(c, snap);   // 写穿透到共享后端（本地模式自动 no-op）
        }
      }
    } catch (e) { console.warn("持久化失败", c, e); }
  }
}, 600);

export function save(...collections) {
  (collections.length ? collections : ["meta"]).forEach(c => dirty.add(c));
  persist();
  emit("change", { collections });
}

/* 专用事务接口返回的服务器规范文档只写本地缓存，不再触发整集合回推。 */
export async function cacheCanonicalDocuments(collection, ...items) {
  if (!db.collections.includes(collection)) return;
  const docs = items.flat().filter(item => item?.id);
  if (!docs.length) return;
  await db.putMany(collection, JSON.parse(JSON.stringify(docs)));
  emit("change", { collections: [collection], phase: "canonical-ack" });
}

/* 恢复索引等关键增量数据必须等待服务器确认。
   普通 saveIncremental 为了轮询性能会静默后台写入，不适合承载“刷新后仍必须存在”的恢复结果。 */
export async function persistRecoveredDocuments(collection, ...items) {
  if (!db.collections.includes(collection)) throw new Error("未知数据集合");
  const docs = items.flat().filter(item => item?.id).map(item => JSON.parse(JSON.stringify(item)));
  if (!docs.length) return { ok: true, local: 0, remote: 0 };
  await db.putMany(collection, docs);
  if (!remote.isOn()) {
    emit("change", { collections: [collection], phase: "recovery-local" });
    return { ok: true, local: docs.length, remote: 0 };
  }
  let lastError = null;
  for (const waitMs of [0, 500, 1500]) {
    if (waitMs) await new Promise(resolve => globalThis.setTimeout(resolve, waitMs));
    try {
      // Recovery checkpoints are single-document upserts. Give SQLite lock
      // contention enough time to settle, while keeping the three attempts
      // bounded and visible to the caller.
      const result = await remote.syncCollection(collection, docs, {
        timeoutMs: remote.RECOVERY_SYNC_TIMEOUT_MS,
        transientRetries: 0,
      });
      emit("change", { collections: [collection], phase: "recovery-ack" });
      return { ok: true, local: docs.length, remote: docs.length, result };
    } catch (error) {
      lastError = error;
    }
  }
  emit("change", { collections: [collection], phase: "recovery-pending" });
  throw lastError || new Error("服务器恢复写入失败");
}

export async function persistNow() {
  await flushIncremental();
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
        if (syncDirty.has(c) && !EXPLICIT_REMOTE_COLLECTIONS.has(c)) {
          remote.putCollection(c, snap);
        }
      }
    } catch (e) { /* 静默 */ }
  }
}

/* ---- 启动装载 ---- */
export async function loadIdentityCache() {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const [membersMeta, productMeta, apiKeysMeta, uiMeta, roleMeta, notifications] = await Promise.all([
    db.metaGet("members").catch(() => []),
    db.metaGet("products").catch(() => []),
    db.metaGet("apiKeys").catch(() => []),
    db.metaGet("ui").catch(() => null),
    db.metaGet("role").catch(() => null),
    db.getAll("notifications").catch(() => [])
  ]);
  state.members = membersMeta || [];
  state.products = productMeta || [];
  state.apiKeys = apiKeysMeta || [];
  if (uiMeta) Object.assign(state.ui, uiMeta);
  state.role = roleMeta || null;
  state.notifications = notifications || [];
  state.notifications.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  remote.recordPerformance("local-identity-load", {
    durationMs: Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt)),
    collections: ["meta", "notifications"],
    collectionCount: 2,
    phase: "startup",
    ok: true
  });
}

export async function loadAll() {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const [collectionRows, membersMeta, productMetaRaw, apiKeysMeta, uiMeta, roleMeta] = await Promise.all([
    Promise.all(db.collections.map(c => db.getAll(c).catch(() => []))),
    db.metaGet("members").catch(() => []),
    db.metaGet("products").catch(() => []),
    db.metaGet("apiKeys").catch(() => []),
    db.metaGet("ui").catch(() => null),
    db.metaGet("role").catch(() => null)
  ]);
  db.collections.forEach((c, index) => { state[c] = collectionRows[index] || []; });
  const normalizedFailureFallbacks = normalizeLegacyInputFallbackState(state);
  for (const [collection, count] of Object.entries(normalizedFailureFallbacks)) {
    if (!count || !db.collections.includes(collection)) continue;
    await db.replaceAll(collection, JSON.parse(JSON.stringify(state[collection] || []))).catch(() => null);
  }
  state.members = membersMeta || [];
  const productMeta = productMetaRaw || [];
  if (!state.products.length && productMeta.length) state.products = productMeta;
  state.apiKeys = apiKeysMeta || [];
  const ui = uiMeta;
  if (ui) Object.assign(state.ui, ui);
  state.role = roleMeta || null;
  remote.recordPerformance("local-idb-load", {
    durationMs: Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt)),
    collections: db.collections,
    collectionCount: db.collections.length,
    phase: "startup",
    ok: true
  });
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
      if (remote.isOn() && remote.hasToken()) {
        remote.syncCollection("voicePresets", JSON.parse(JSON.stringify(migrated)))
          .catch(e => console.warn("历史定制音色迁移同步失败", e));
      }
    }
    delete state.ui.customVoices;
    db.metaSet("ui", JSON.parse(JSON.stringify(state.ui)));
  }
  if (state.ui.assetSeq == null) state.ui.assetSeq = state.assets.filter(a => !a.delivered).length;
  // 历史发布序号由服务端统一投影 / 受控迁移；浏览器绝不能从可见子集写回
  // pubSeq，否则不同创作者或供应商会把同一全局账本改成个人计数。
  {
    const delivered = state.assets.filter(a => a.delivered);
    state.ui.deliverSeq = Math.max(
      state.ui.deliverSeq || 0,
      delivered.reduce((max, asset) => Math.max(max, Number(asset.pubSeq || asset.projectedSeq || 0)), 0)
    );
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

/* 登录只等待账号、产品和音色等首屏关键集合；其余集合在进入首页后分组同步。
   分组请求兼容旧服务：若服务端忽略 collections 并返回了全量快照，客户端只消费一次，
   不会继续重复下载同一份大状态。 */
export const REMOTE_BOOTSTRAP_COLLECTIONS = ["accounts", "products", "voicePresets"];
export const REMOTE_SUPPLIER_BOOTSTRAP_COLLECTIONS = ["accounts", "products"];
export const REMOTE_DEFERRED_COLLECTION_GROUPS = [
  // 刷新批量生产时先返回轻量会话索引，让左栏和当前会话立即可见。
  // production 与 job 携带的产物/轮询状态更大，分组返回可避免它们把整个导航锁在开屏。
  ["sessions", "batches"],
  ["productions"],
  ["jobs"],
  ["assets"],
  ["analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory"]
];
const REMOTE_STATE_COLLECTIONS = [...remote.SYNCED];
let remoteSyncGeneration = 0;
let remoteBootstrapContext = null;
let remoteHydrationRun = null;
const remoteHydrationState = {
  memberId: "",
  pending: new Set(),
  failed: new Set()
};

function resetRemoteHydrationState(memberId = "") {
  remoteHydrationState.memberId = String(memberId || "");
  remoteHydrationState.pending = new Set();
  remoteHydrationState.failed = new Set();
}

function announceRemoteHydrationState() {
  emit("remote:hydration-state", {
    memberId: remoteHydrationState.memberId,
    pending: [...remoteHydrationState.pending],
    failed: [...remoteHydrationState.failed]
  });
}

export function remoteCollectionHydrationState(collections = []) {
  const wanted = new Set((collections || []).filter(Boolean));
  return {
    pending: [...remoteHydrationState.pending].filter(name => wanted.has(name)),
    failed: [...remoteHydrationState.failed].filter(name => wanted.has(name))
  };
}

function isRemoteSyncCurrent(generation, memberId) {
  return generation === remoteSyncGeneration
    && !!remote.hasToken()
    && state.ui.currentMemberId === memberId;
}

/* 退出或切换账号时立即使旧请求失效。已进入 IndexedDB 事务的单次写入
   无法中途取消，但新账号后创建的同 store 事务会在其后覆盖；旧链路不会再启动下一次写入。 */
export function cancelRemoteHydration() {
  remoteSyncGeneration += 1;
  remoteBootstrapContext = null;
  remoteHydrationRun = null;
  resetRemoteHydrationState();
}

export function remoteBootstrapCollectionsForRole(role = state.role) {
  return ["supplier", "supplier_parent", "supplier_child"].includes(role)
    ? REMOTE_SUPPLIER_BOOTSTRAP_COLLECTIONS
    : REMOTE_BOOTSTRAP_COLLECTIONS;
}

function cloneRemoteRows(value) {
  return JSON.parse(JSON.stringify(value || []));
}

function returnedRemoteCollections(snap) {
  return REMOTE_STATE_COLLECTIONS.filter(name => Array.isArray(snap?.[name]));
}

function applyRemoteSnapshot(snap, requested = REMOTE_STATE_COLLECTIONS) {
  const applied = [];
  requested.forEach(name => {
    if (!Array.isArray(snap?.[name])) return;
    state[name] = cloneRemoteRows(snap[name]);
    applied.push(name);
  });
  if (Array.isArray(snap?.members)) state.members = cloneRemoteRows(snap.members);
  normalizeLegacyInputFallbackState(state);
  state.notifications.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  state.sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return applied;
}

function idleTurn() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 120 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function retryPause(ms = 420) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchRemoteStateGroup(collections, isCurrent = () => true) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!isCurrent()) {
      const cancelled = new Error("工作区同步已取消");
      cancelled.code = "remote-sync-cancelled";
      throw cancelled;
    }
    try {
      return await remote.getState(["members", ...collections]);
    } catch (error) {
      lastError = error;
      if (attempt < 2 && isCurrent()) await retryPause();
    }
  }
  throw lastError || new Error("工作区同步失败");
}

async function cacheRemoteSnapshot(snap, collections, phase = "background", isCurrent = () => true) {
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const normalizedSnapshot = {};
  REMOTE_STATE_COLLECTIONS.forEach(name => {
    if (Array.isArray(snap?.[name])) normalizedSnapshot[name] = cloneRemoteRows(snap[name]);
  });
  normalizeLegacyInputFallbackState(normalizedSnapshot);
  for (const name of collections) {
    if (!Array.isArray(snap?.[name])) continue;
    if (!isCurrent()) return false;
    await idleTurn();
    if (!isCurrent()) return false;
    const rows = normalizedSnapshot[name] || cloneRemoteRows(snap[name]);
    try { await db.replaceAll(name, rows); } catch (_) { /* 本地缓存失败不影响服务端权威状态 */ }
  }
  if (Array.isArray(snap?.members) && isCurrent()) {
    await db.metaSet("members", cloneRemoteRows(snap.members)).catch(() => null);
  }
  if (!isCurrent()) return false;
  const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  remote.recordPerformance("state-idb", {
    durationMs: Math.max(0, Math.round(endedAt - startedAt)),
    collections,
    collectionCount: collections.length,
    phase,
    ok: true
  });
  return true;
}

function clearRemoteMemoryBeforeLogin() {
  REMOTE_STATE_COLLECTIONS.forEach(name => { state[name] = []; });
  state.members = [];
}

/* 返回 { ok, complete }：complete=true 表示旧服务忽略了筛选并已返回全量，
   或所有同步集合已随首包返回，因此无需再发后台分组请求。 */
export async function pullRemoteBootstrap() {
  if (!remote.isOn() || !remote.hasToken()) return { ok: false, complete: false };
  const memberId = state.ui.currentMemberId;
  const generation = ++remoteSyncGeneration;
  remoteBootstrapContext = null;
  resetRemoteHydrationState(memberId);
  REMOTE_STATE_COLLECTIONS.forEach(name => remoteHydrationState.pending.add(name));
  clearRemoteMemoryBeforeLogin();
  let snap;
  const bootstrapCollections = remoteBootstrapCollectionsForRole();
  try {
    snap = await remote.getState(["members", ...bootstrapCollections]);
  } catch {
    resetRemoteHydrationState();
    return { ok: false, complete: false };
  }
  if (!isRemoteSyncCurrent(generation, memberId)) return { ok: false, complete: false };
  const returned = returnedRemoteCollections(snap);
  const requested = new Set(bootstrapCollections);
  const serverReturnedExtra = returned.some(name => !requested.has(name));
  const applied = applyRemoteSnapshot(snap, serverReturnedExtra ? returned : bootstrapCollections);
  const complete = REMOTE_STATE_COLLECTIONS.every(name => returned.includes(name));
  remoteBootstrapContext = {
    generation,
    memberId,
    complete,
    applied: new Set(applied)
  };
  remoteHydrationState.pending = new Set(
    REMOTE_STATE_COLLECTIONS.filter(name => !remoteBootstrapContext.applied.has(name))
  );
  remoteHydrationState.failed.clear();
  announceRemoteHydrationState();
  void cacheRemoteSnapshot(
    snap,
    applied,
    "bootstrap",
    () => isRemoteSyncCurrent(generation, memberId)
  ).catch(() => null);

  const supplierReadOnly = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  if (!supplierReadOnly) await ensureProductsSeed();
  if (!isRemoteSyncCurrent(generation, memberId)) return { ok: false, complete: false };
  emit("change", { collections: applied, phase: "bootstrap" });
  return { ok: true, complete };
}

/* 登录后的重集合同步。调用方不要 await 它来打开登录门；可通过 onProgress 渐进刷新
   首页/草稿/发布清单，编辑器和定制创作页面不会被强制重挂载。 */
export function hydrateRemoteInBackground({ memberId = state.ui.currentMemberId, onProgress } = {}) {
  const context = remoteBootstrapContext;
  if (!context || context.memberId !== memberId || !isRemoteSyncCurrent(context.generation, memberId)) {
    return Promise.resolve(false);
  }
  if (remoteHydrationRun?.generation === context.generation) return remoteHydrationRun.promise;
  const { generation } = context;
  const bootstrapCollectionsApplied = new Set(context.applied);
  const isCurrent = () => isRemoteSyncCurrent(generation, memberId);
  remoteHydrationState.memberId = String(memberId || "");
  remoteHydrationState.failed.clear();
  remoteHydrationState.pending = new Set(
    REMOTE_STATE_COLLECTIONS.filter(name => !bootstrapCollectionsApplied.has(name))
  );
  announceRemoteHydrationState();
  let keepContextForRetry = false;
  const promise = (async () => {
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const appliedAll = new Set();
    try {
      if (context.complete) {
        REMOTE_STATE_COLLECTIONS.forEach(name => appliedAll.add(name));
      } else {
        for (const group of REMOTE_DEFERRED_COLLECTION_GROUPS) {
          const pendingGroup = group.filter(name => !bootstrapCollectionsApplied.has(name));
          if (!pendingGroup.length) continue;
          if (!isCurrent()) return false;
          const snap = await fetchRemoteStateGroup(pendingGroup, isCurrent);
          if (!isCurrent()) return false;
          const returned = returnedRemoteCollections(snap);
          const requested = new Set(pendingGroup);
          const serverReturnedExtra = returned.some(name => !requested.has(name) && !bootstrapCollectionsApplied.has(name));
          const remainingBeforeApply = REMOTE_STATE_COLLECTIONS.filter(name => !bootstrapCollectionsApplied.has(name));
          const serverReturnedAllRemaining = remainingBeforeApply.every(name => returned.includes(name));
          const names = serverReturnedExtra ? returned : pendingGroup;
          const applied = applyRemoteSnapshot(snap, names);
          applied.forEach(name => {
            appliedAll.add(name);
            bootstrapCollectionsApplied.add(name);
            context.applied.add(name);
            remoteHydrationState.pending.delete(name);
            remoteHydrationState.failed.delete(name);
          });
          announceRemoteHydrationState();
          emit("change", { collections: applied, phase: "background" });
          try { onProgress?.({ collections: applied, complete: false }); } catch (_) {}
          // 本地缓存只是离线副本，不能阻塞下一组服务端数据请求或页面水合。
          // generation/member 守卫仍会阻止切换账号后的旧快照继续落盘。
          void cacheRemoteSnapshot(snap, applied, "background", isCurrent).catch(() => null);
          if (!isCurrent()) return false;
          if (serverReturnedAllRemaining) break;
        }
      }

      if (!isCurrent()) return false;
      const supplierReadOnly = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
      if (!supplierReadOnly) {
        await ensureProductsSeed();
        // 登录后的后台水合只维护本地缓存，不把快照二次回推服务端。
        await normalizeProductTermsInState({ persistLocal: true, pushRemote: false });
      }
      if (!isCurrent()) return false;
      const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      remote.recordPerformance("state-hydration", {
        durationMs: Math.max(0, Math.round(endedAt - startedAt)),
        collections: [...appliedAll],
        collectionCount: appliedAll.size,
        phase: "background",
        ok: true
      });
      emit("remote:hydrated", { collections: [...appliedAll], complete: true });
      remoteHydrationState.pending.clear();
      remoteHydrationState.failed.clear();
      announceRemoteHydrationState();
      try { onProgress?.({ collections: [...appliedAll], complete: true }); } catch (_) {}
      return true;
    } catch (error) {
      if (error?.code === "remote-sync-cancelled" || !isCurrent()) return false;
      remote.recordPerformance("state-hydration", {
        durationMs: Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt)),
        collections: [...appliedAll],
        collectionCount: appliedAll.size,
        phase: "background",
        ok: false
      });
      console.warn("后台工作区同步失败", error);
      keepContextForRetry = true;
      const failedCollections = REMOTE_STATE_COLLECTIONS.filter(name => !bootstrapCollectionsApplied.has(name));
      remoteHydrationState.pending.clear();
      remoteHydrationState.failed = new Set(failedCollections);
      announceRemoteHydrationState();
      emit("remote:hydration-error", {
        collections: failedCollections,
        retryable: true
      });
      try {
        onProgress?.({
          collections: failedCollections,
          complete: false,
          error: true,
          retryable: true
        });
      } catch (_) {}
      return false;
    } finally {
      if (!keepContextForRetry && remoteBootstrapContext?.generation === generation) remoteBootstrapContext = null;
      if (remoteHydrationRun?.generation === generation) remoteHydrationRun = null;
    }
  })();
  remoteHydrationRun = { generation, promise };
  return promise;
}

export function retryRemoteHydration({ onProgress } = {}) {
  const memberId = state.ui.currentMemberId;
  if (!remoteBootstrapContext || !memberId || !remote.hasToken()) return Promise.resolve(false);
  return hydrateRemoteInBackground({ memberId, onProgress });
}

/* 登录后从服务端拉全量快照覆盖本地 + 回写 IndexedDB 缓存（离线可用）。
   共享模式下服务器是权威源：绝不把本机旧缓存当作 localOnly 回推。
   这样 A 删除账号/资产后，B 的旧 IndexedDB 不会在下次刷新时把它复活。
   离线/纯本地模式不进入这里，仍保留本地数据。 */
export async function pullRemote() {
  if (!remote.isOn() || !remote.hasToken()) return false;
  let snap;
  try { snap = await remote.getState(); } catch { return false; }
  const applied = applyRemoteSnapshot(snap, db.collections);
  await cacheRemoteSnapshot(snap, applied, "explicit");
  const supplierReadOnly = ["supplier", "supplier_parent", "supplier_child"].includes(state.role);
  if (!supplierReadOnly) {
    await ensureProductsSeed();
    await normalizeProductTermsInState({ persistLocal: true, pushRemote: true });
    if (Array.isArray(snap.products) && !snap.products.length) remote.putCollection("products", state.products);
  }
  emit("change", { collections: db.collections });
  return true;
}

/* 页面重新进入 / 窗口重新聚焦时，只刷新指定权威集合。它不会递增登录
   generation、不会取消正在进行的后台水合，也不会把本地整集合回推服务端。 */
export async function refreshRemoteCollections(collections = []) {
  if (!remote.isOn() || !remote.hasToken()) return false;
  const requested = [...new Set((collections || []).filter(name => (
    REMOTE_STATE_COLLECTIONS.includes(name)
  )))];
  if (!requested.length) return false;
  const memberId = state.ui.currentMemberId;
  const generation = remoteSyncGeneration;
  const isCurrent = () => isRemoteSyncCurrent(generation, memberId);
  const snap = await fetchRemoteStateGroup(requested, isCurrent);
  if (!isCurrent()) return false;
  const applied = applyRemoteSnapshot(snap, requested);
  if (!isCurrent()) return false;
  emit("change", { collections: applied, phase: "authority-refresh" });
  void cacheRemoteSnapshot(
    snap,
    applied,
    "authority-refresh",
    isCurrent,
  ).catch(() => null);
  return applied.length > 0;
}

let deliveryMetricRefreshPromise = null;
let deliveryMetricRefreshedAt = 0;
const DELIVERY_METRIC_REFRESH_WINDOW_MS = 4000;
const DELIVERY_METRIC_GROUPS = [
  ["viewCount", "viewsUpdatedAt", "viewsUpdatedBy"],
  ["exposureCount", "exposureUpdatedAt", "exposureUpdatedBy"],
];
const DELIVERY_AUTHORITY_FIELDS = [
  "supplierDownloadedAt",
  "supplierDownloadedBy",
  "publishedUrl",
  "supplierNote",
  "publishedTitle",
  "publishedRawText",
  "publishedAt",
  "publishedUpdatedAt",
  "publishedUpdatedBy",
  "publishedClearedAt",
  "publishedWithoutLink",
  "status",
];

export function applyDeliveryMetricProjection(asset, row) {
  if (!asset || !row || String(asset.id || "") !== String(row.id || "")) return false;
  let changed = false;
  for (const [valueField, updatedAtField, updatedByField] of DELIVERY_METRIC_GROUPS) {
    const incomingUpdatedAt = Math.max(0, Number(row?.[updatedAtField] || 0));
    const currentUpdatedAt = Math.max(0, Number(asset?.[updatedAtField] || 0));
    if (incomingUpdatedAt < currentUpdatedAt) continue;
    for (const field of [valueField, updatedAtField, updatedByField]) {
      const next = row?.[field] ?? (field.endsWith("By") ? "" : 0);
      if (asset[field] === next) continue;
      asset[field] = next;
      changed = true;
    }
  }
  for (const field of DELIVERY_AUTHORITY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
    const next = row[field] ?? (field.endsWith("At") ? 0 : "");
    if (asset[field] === next) continue;
    asset[field] = next;
    changed = true;
  }
  return changed;
}

/* 供应商交付状态采用专用服务端权威投影。只原位合并指标、下载和
   当前发布状态，不替换资产集合，也不会把浏览器旧快照回推服务端。 */
export async function refreshDeliveryMetrics({ force = false } = {}) {
  if (!remote.isOn() || !remote.hasToken()) return { refreshed: false, changed: false };
  if (deliveryMetricRefreshPromise) return deliveryMetricRefreshPromise;
  if (!force && Date.now() - deliveryMetricRefreshedAt < DELIVERY_METRIC_REFRESH_WINDOW_MS) {
    return { refreshed: false, changed: false };
  }
  const memberId = state.ui.currentMemberId;
  const generation = remoteSyncGeneration;
  const isCurrent = () => isRemoteSyncCurrent(generation, memberId);
  deliveryMetricRefreshPromise = remote.deliveryMetrics()
    .then(payload => {
      if (!isCurrent()) return { refreshed: false, changed: false };
      const byId = new Map(state.assets.map(asset => [String(asset?.id || ""), asset]));
      let changed = false;
      const changedAssets = [];
      for (const row of payload?.items || []) {
        const asset = byId.get(String(row?.id || ""));
        if (!asset) continue;
        if (applyDeliveryMetricProjection(asset, row)) {
          changed = true;
          changedAssets.push(asset);
        }
      }
      deliveryMetricRefreshedAt = Date.now();
      if (changed) {
        void db.putMany("assets", changedAssets).catch(() => null);
        emit("change", { collections: ["assets"], phase: "delivery-metrics" });
      }
      return { refreshed: true, changed };
    })
    .finally(() => { deliveryMetricRefreshPromise = null; });
  return deliveryMetricRefreshPromise;
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
