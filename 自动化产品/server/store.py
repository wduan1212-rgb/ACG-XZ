"""共享后端存储（Phase 1）：SQLite 文档表 + 成员表 + 口令哈希 + 无状态签名 token。

设计取舍：用「文档表」整条存 JSON，而不是给每类实体逐一建关系表——前端 schema 仍在演进，
文档存零映射、最稳，前端域模型一行不用改。团队规模够用；要扩 Postgres 时把本文件换实现即可（接口不变）。
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from threading import Lock

DB_PATH = Path(os.getenv("DATA_DB", Path(__file__).resolve().parent / "data.sqlite"))
DEFAULT_ADMIN_USERNAME = os.getenv("DEFAULT_ADMIN_USERNAME") or bytes.fromhex("61646d696e").decode()
DEFAULT_SUPPLIER_USERNAME = os.getenv("DEFAULT_SUPPLIER_USERNAME") or bytes.fromhex("676f6e6779696e677368616e67").decode()
DEFAULT_ADMIN_PIN_HASH = os.getenv("DEFAULT_ADMIN_PIN_HASH") or "pbkdf2$120000$737461722d61727261792d61646d696e2d7631$1d5f7e973e925fb41415dd6b322a3e8d6e3ab272e0c8ce8961393abd9af8edba"
DEFAULT_SUPPLIER_PIN_HASH = os.getenv("DEFAULT_SUPPLIER_PIN_HASH") or "pbkdf2$120000$737461722d61727261792d737570706c6965722d7631$a5b6620381cff96c4602112ab5b3ee89b027d53c263d4452150cc9c7d9d5e1ff"

# 入服务器共享的集合（与前端 db.collections 对齐）。
# notifications / ui / apiKeys 是每设备本地态，不入服务器。
COLLECTIONS = [
    "accounts", "productions", "assets", "sessions", "batches", "jobs",
    "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory", "products", "voicePresets",
]
# 按 owner 隔离的集合（创作互不干扰）；其余全员共享。jobs 跟随其 production 的可见性。
OWNED = {"productions", "sessions", "batches", "voicePresets"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs(
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  owner_id   TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  data       TEXT NOT NULL,
  PRIMARY KEY(collection, id)
);
CREATE INDEX IF NOT EXISTS idx_docs_owner ON docs(collection, owner_id);
CREATE TABLE IF NOT EXISTS deleted_docs(
  collection TEXT NOT NULL,
  id         TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY(collection, id)
);
CREATE TABLE IF NOT EXISTS members(
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  username   TEXT NOT NULL UNIQUE,
  pin_hash   TEXT NOT NULL,
  role       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS member_requests(
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  username    TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,
  role        TEXT NOT NULL,
  status      TEXT NOT NULL,
  message     TEXT,
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT
);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
"""

_lock = Lock()
_initialized = False


def _connect():
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _seed_admin_locked(conn):
    if conn.execute("SELECT COUNT(*) FROM members").fetchone()[0] == 0:
        now = int(time.time() * 1000)
        conn.execute(
            "INSERT INTO members(id,name,username,pin_hash,role,created_at) VALUES(?,?,?,?,?,?)",
            (uuid.uuid4().hex[:10], "管理员", DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PIN_HASH, "admin", now),
        )
        conn.execute(
            "INSERT INTO members(id,name,username,pin_hash,role,created_at) VALUES(?,?,?,?,?,?)",
            (uuid.uuid4().hex[:10], "供应商", DEFAULT_SUPPLIER_USERNAME, DEFAULT_SUPPLIER_PIN_HASH, "supplier", now + 1),
        )


def _ensure_admin_alias_locked(conn):
    admin = conn.execute("SELECT id,pin_hash,role,name FROM members WHERE username=?", (DEFAULT_ADMIN_USERNAME,)).fetchone()
    if admin:
        if admin[1] != DEFAULT_ADMIN_PIN_HASH or admin[2] != "admin" or admin[3] != "管理员":
            conn.execute(
                "UPDATE members SET name=?, pin_hash=?, role=? WHERE id=?",
                ("管理员", DEFAULT_ADMIN_PIN_HASH, "admin", admin[0]),
            )
        return
    old = conn.execute("SELECT id FROM members WHERE username='yuxuan' AND role='admin'").fetchone()
    if old:
        conn.execute(
            "UPDATE members SET username=?, name=?, pin_hash=?, role=? WHERE id=?",
            (DEFAULT_ADMIN_USERNAME, "管理员", DEFAULT_ADMIN_PIN_HASH, "admin", old[0]),
        )
        return
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO members(id,name,username,pin_hash,role,created_at) VALUES(?,?,?,?,?,?)",
        (uuid.uuid4().hex[:10], "管理员", DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PIN_HASH, "admin", now),
    )


def _ensure_db():
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        conn = _connect()
        try:
            conn.executescript(SCHEMA)
            _seed_admin_locked(conn)
            _ensure_admin_alias_locked(conn)
            conn.commit()
            _initialized = True
        finally:
            conn.close()


def _fetchone(sql, params=()):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            return conn.execute(sql, params).fetchone()
        finally:
            conn.close()


def _fetchall(sql, params=()):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()


# ---------- 口令哈希（pbkdf2，纯 stdlib，无新依赖） ----------
def hash_pin(pin: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 120_000)
    return f"pbkdf2$120000${salt.hex()}${dk.hex()}"


def verify_pin(pin: str, stored: str) -> bool:
    try:
        _algo, iters, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


# ---------- 无状态签名 token（HMAC，重启不失效：secret 落 meta） ----------
TOKEN_TTL = 7 * 24 * 3600


def _secret() -> bytes:
    env = os.getenv("AUTH_SECRET")
    if env:
        return env.encode()
    row = _fetchone("SELECT v FROM meta WHERE k='auth_secret'")
    if row:
        return bytes.fromhex(row[0])
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT v FROM meta WHERE k='auth_secret'").fetchone()
            if row:
                return bytes.fromhex(row[0])
            s = secrets.token_bytes(32)
            conn.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('auth_secret',?)", (s.hex(),))
            conn.commit()
        finally:
            conn.close()
    return s


def make_token(member_id: str) -> str:
    payload = f"{member_id}:{int(time.time()) + TOKEN_TTL}"
    sig = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}:{sig}".encode()).decode()


def parse_token(token: str):
    try:
        raw = base64.urlsafe_b64decode(token.encode()).decode()
        member_id, exp, sig = raw.rsplit(":", 2)
        good = hmac.new(_secret(), f"{member_id}:{exp}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, good) or int(exp) < time.time():
            return None
        return member_id
    except Exception:
        return None


# ---------- 成员 ----------
def _seed_admin():
    _ensure_db()


def _member_public(row):
    return {"id": row[0], "name": row[1], "username": row[2], "role": row[4], "createdAt": row[5]}


def add_member(name, username, pin, role):
    return add_member_with_hash(name, username, hash_pin(pin), role)


def add_member_with_hash(name, username, pin_hash, role):
    mid = uuid.uuid4().hex[:10]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO members(id,name,username,pin_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                (mid, name, username, pin_hash, role, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()
    return get_member(mid)


def get_member(mid):
    return _fetchone("SELECT id,name,username,pin_hash,role,created_at FROM members WHERE id=?", (mid,))


def get_member_by_username(username):
    return _fetchone("SELECT id,name,username,pin_hash,role,created_at FROM members WHERE username=?", (username,))


def list_members():
    rows = _fetchall("SELECT id,name,username,pin_hash,role,created_at FROM members ORDER BY created_at")
    return [_member_public(r) for r in rows]


def update_member(mid, name=None, username=None, role=None, pin=None):
    sets, vals = [], []
    if name is not None:
        sets.append("name=?"); vals.append(name)
    if username is not None:
        sets.append("username=?"); vals.append(username)
    if role is not None:
        sets.append("role=?"); vals.append(role)
    if pin:
        sets.append("pin_hash=?"); vals.append(hash_pin(pin))
    if sets:
        vals.append(mid)
        _ensure_db()
        with _lock:
            conn = _connect()
            try:
                conn.execute(f"UPDATE members SET {','.join(sets)} WHERE id=?", vals)
                conn.commit()
            finally:
                conn.close()
    return get_member(mid)


def delete_member(mid):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("DELETE FROM members WHERE id=?", (mid,))
            conn.commit()
        finally:
            conn.close()


def member_public(row):
    return _member_public(row)


# ---------- 成员申请 ----------
def _request_public(row):
    return {
        "id": row[0],
        "name": row[1],
        "username": row[2],
        "role": row[4],
        "status": row[5],
        "message": row[6] or "",
        "createdAt": row[7],
        "reviewedAt": row[8],
        "reviewedBy": row[9],
    }


def add_member_request(name, username, pin, role, message=""):
    rid = uuid.uuid4().hex[:10]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO member_requests(id,name,username,pin_hash,role,status,message,created_at,reviewed_at,reviewed_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (rid, name, username, hash_pin(pin), role, "pending", message, int(time.time() * 1000), None, None),
            )
            conn.commit()
        finally:
            conn.close()
    return get_member_request(rid)


def get_member_request(rid):
    row = _fetchone("SELECT id,name,username,pin_hash,role,status,message,created_at,reviewed_at,reviewed_by FROM member_requests WHERE id=?", (rid,))
    return row


def list_member_requests(status=None):
    if status:
        rows = _fetchall("SELECT id,name,username,pin_hash,role,status,message,created_at,reviewed_at,reviewed_by FROM member_requests WHERE status=? ORDER BY created_at DESC", (status,))
    else:
        rows = _fetchall("SELECT id,name,username,pin_hash,role,status,message,created_at,reviewed_at,reviewed_by FROM member_requests ORDER BY created_at DESC")
    return [_request_public(r) for r in rows]


def username_has_pending_request(username):
    row = _fetchone("SELECT id FROM member_requests WHERE username=? AND status='pending'", (username,))
    return bool(row)


def approve_member_request(rid, reviewer_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT id,name,username,pin_hash,role,status FROM member_requests WHERE id=?", (rid,)).fetchone()
            if not row:
                return None, "not_found"
            if row[5] != "pending":
                return None, "not_pending"
            if conn.execute("SELECT id FROM members WHERE username=?", (row[2],)).fetchone():
                return None, "username_exists"
            mid = uuid.uuid4().hex[:10]
            now = int(time.time() * 1000)
            conn.execute(
                "INSERT INTO members(id,name,username,pin_hash,role,created_at) VALUES(?,?,?,?,?,?)",
                (mid, row[1], row[2], row[3], row[4], now),
            )
            conn.execute(
                "UPDATE member_requests SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?",
                (now, reviewer_id, rid),
            )
            conn.commit()
        finally:
            conn.close()
    return get_member(mid), None


def reject_member_request(rid, reviewer_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT id,status FROM member_requests WHERE id=?", (rid,)).fetchone()
            if not row:
                return False, "not_found"
            if row[1] != "pending":
                return False, "not_pending"
            conn.execute(
                "UPDATE member_requests SET status='rejected', reviewed_at=?, reviewed_by=? WHERE id=?",
                (int(time.time() * 1000), reviewer_id, rid),
            )
            conn.commit()
        finally:
            conn.close()
    return True, None


# ---------- 文档（写穿透：按 id upsert，后写胜，绝不整表删→不冲掉别人） ----------
def _guard_suspicious_account_bulk(conn, items):
    """防旧前端/旧浏览器缓存把已清理账号大批量回推到服务器。

    正常新建账号通常只会带来 1-2 个未知 id；旧 IndexedDB 合并回推会在已有几十个账号时
    突然塞入几十/上百个未知 id。这里在服务端兜底拦截，避免线上清理结果被复活。
    """
    if not items:
        return
    existing = conn.execute("SELECT id FROM docs WHERE collection='accounts'").fetchall()
    existing_ids = {r[0] for r in existing}
    if len(existing_ids) < 10:
        return
    incoming_ids = {str(it.get("id")) for it in items if isinstance(it, dict) and it.get("id")}
    unknown_ids = incoming_ids - existing_ids
    threshold = max(8, int(len(existing_ids) * 0.2))
    if len(unknown_ids) > threshold:
        raise ValueError(
            "suspicious_account_bulk:%s:%s:%s" % (len(existing_ids), len(incoming_ids), len(unknown_ids))
        )


def _account_semantic_key(item):
    if not isinstance(item, dict):
        return None
    platform = str(item.get("platform") or "").strip()
    mode = str(item.get("mode") or "").strip()
    name = str(item.get("name") or "").strip()
    if not (platform and mode and name):
        return None
    return platform, mode, name


def _existing_account_keys(conn):
    keys = {}
    rows = conn.execute("SELECT id,data FROM docs WHERE collection='accounts'").fetchall()
    for doc_id, raw in rows:
        try:
            item = json.loads(raw)
        except Exception:
            continue
        key = _account_semantic_key(item)
        if key and key not in keys:
            keys[key] = doc_id
    return keys


def upsert_docs(collection, items):
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            deleted_ids = {
                r[0] for r in conn.execute("SELECT id FROM deleted_docs WHERE collection=?", (collection,)).fetchall()
            }
            if collection == "accounts":
                _guard_suspicious_account_bulk(conn, items or [])
                semantic_keys = _existing_account_keys(conn)
            else:
                semantic_keys = {}
            for it in items:
                if not isinstance(it, dict) or "id" not in it:
                    continue
                doc_id = str(it["id"])
                if doc_id in deleted_ids:
                    continue
                if collection == "accounts":
                    key = _account_semantic_key(it)
                    existing_id = semantic_keys.get(key)
                    if existing_id and existing_id != doc_id:
                        continue
                ua = int(it.get("updatedAt") or it.get("createdAt") or time.time() * 1000)
                cur = conn.execute(
                    "SELECT updated_at FROM docs WHERE collection=? AND id=?", (collection, doc_id)
                ).fetchone()
                if cur and cur[0] > ua:
                    continue  # 服务器已有更新的版本，跳过（避免旧端覆盖新数据）
                conn.execute(
                    "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                    (collection, doc_id, it.get("ownerId"), ua, json.dumps(it, ensure_ascii=False)),
                )
                if collection == "accounts":
                    key = _account_semantic_key(it)
                    if key:
                        semantic_keys[key] = doc_id
            conn.commit()
        finally:
            conn.close()


def delete_doc(collection, doc_id):
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            did = str(doc_id)
            now = int(time.time() * 1000)
            conn.execute("DELETE FROM docs WHERE collection=? AND id=?", (collection, did))
            conn.execute(
                "INSERT OR REPLACE INTO deleted_docs(collection,id,deleted_at) VALUES(?,?,?)",
                (collection, did, now),
            )
            conn.commit()
        finally:
            conn.close()


def state_for(member_id, role):
    """按成员可见性返回全量快照：创作态按 owner 隔离，发布/共享数据仍全员可见。"""
    _ensure_db()
    out = {}
    visible_prod_ids = set()
    with _lock:
        conn = _connect()
        try:
            for col in COLLECTIONS:
                rows = conn.execute("SELECT data, owner_id FROM docs WHERE collection=?", (col,)).fetchall()
                items = []
                for data, owner in rows:
                    item = json.loads(data)
                    if col in {"sessions", "batches"} and owner and owner != member_id:
                        continue
                    if col == "productions" and owner and owner != member_id and item.get("stage") != "delivered":
                        continue
                    if col == "assets" and owner and owner != member_id and not item.get("delivered") and not item.get("shared"):
                        continue
                    if col == "voicePresets" and owner and owner != member_id:
                        continue
                    items.append(item)
                out[col] = items
                if col == "productions":
                    visible_prod_ids = {p.get("id") for p in items}
        finally:
            conn.close()
    out["jobs"] = [j for j in out.get("jobs", []) if j.get("productionId") in visible_prod_ids]
    return out
