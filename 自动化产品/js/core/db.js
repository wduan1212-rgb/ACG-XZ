/* IndexedDB 分仓存储（v5）：每类实体一个 store，二进制独立存放
   旧库 acgVideoTool(v4) 保持原样不动，作为迁移来源与回滚备份 */

const DB_NAME = "dumateStudioV5";
const DB_VER = 4;
const COLLECTIONS = [
  "accounts", "productions", "assets", "sessions", "batches", "jobs", "notifications",
  "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory", "products", "voicePresets"
];

let _db = null;

export const db = {
  collections: COLLECTIONS,

  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        COLLECTIONS.forEach(c => { if (!d.objectStoreNames.contains(c)) d.createObjectStore(c, { keyPath: "id" }); });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
        if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
      };
      r.onsuccess = () => { _db = r.result; res(_db); };
      r.onerror = () => rej(r.error);
    });
  },

  ready() { return !!_db; },

  tx(store, mode = "readonly") {
    return _db.transaction(store, mode).objectStore(store);
  },

  getAll(store) {
    return new Promise((res, rej) => {
      if (!_db) return res([]);
      const rq = this.tx(store).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror = () => rej(rq.error);
    });
  },

  /* 整集合覆写：clear + bulk put（集合规模小，一致性优先） */
  replaceAll(store, items) {
    return new Promise((res, rej) => {
      if (!_db) return res();
      const tx = _db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      os.clear();
      (items || []).forEach(it => { try { os.put(it); } catch (e) { /* 跳过不可克隆项 */ } });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },

  /* 高频轮询只增量写入变化文档，避免 clear + 全集合重放。 */
  putMany(store, items) {
    return new Promise((res, rej) => {
      if (!_db) return res();
      const tx = _db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      (items || []).forEach(it => {
        if (!it?.id) return;
        try { os.put(it); } catch (e) { /* 跳过不可克隆项 */ }
      });
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },

  metaGet(key) {
    return new Promise((res, rej) => {
      if (!_db) return res(undefined);
      const rq = this.tx("meta").get(key);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  },
  metaSet(key, val) {
    return new Promise((res, rej) => {
      if (!_db) return res();
      const tx = _db.transaction("meta", "readwrite");
      tx.objectStore("meta").put(val, key);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },

  putBlob(id, blob) {
    return new Promise((res, rej) => {
      if (!_db) return res();
      const tx = _db.transaction("blobs", "readwrite");
      tx.objectStore("blobs").put(blob, id);
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  },
  getBlob(id) {
    return new Promise((res, rej) => {
      if (!_db) return res(null);
      const rq = this.tx("blobs").get(id);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  },
  getAllBlobEntries() {
    return new Promise((res, rej) => {
      if (!_db) return res([]);
      const out = [];
      const rq = this.tx("blobs").openCursor();
      rq.onsuccess = () => {
        const cur = rq.result;
        if (cur) { out.push({ id: cur.key, blob: cur.value }); cur.continue(); }
        else res(out);
      };
      rq.onerror = () => rej(rq.error);
    });
  },
  delBlob(id) {
    return new Promise((res) => {
      if (!_db) return res();
      const tx = _db.transaction("blobs", "readwrite");
      tx.objectStore("blobs").delete(id);
      tx.oncomplete = res;
      tx.onerror = () => res();
    });
  },

  async wipe() {
    if (!_db) return;
    for (const c of [...COLLECTIONS, "blobs"]) await this.replaceAll(c, []);
    const tx = _db.transaction("meta", "readwrite");
    tx.objectStore("meta").clear();
    return new Promise(res => { tx.oncomplete = res; tx.onerror = res; });
  }
};

/* 旧库只读访问（迁移用） */
export function openLegacyState() {
  return new Promise((res) => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; res(v); } };
    try {
      const r = indexedDB.open("acgVideoTool", 1);
      r.onupgradeneeded = () => { /* 旧库不存在时不创建数据 */ };
      r.onsuccess = () => {
        const d = r.result;
        try {
          if (!d.objectStoreNames.contains("kv")) { d.close(); return done(null); }
          const rq = d.transaction("kv").objectStore("kv").get("state");
          rq.onsuccess = () => { const v = rq.result || null; d.close(); done(v); };
          rq.onerror = () => { d.close(); done(null); };
        } catch (e) { d.close(); done(null); }
      };
      r.onerror = () => done(null);
      setTimeout(() => done(null), 3000);
    } catch (e) { done(null); }
  });
}
