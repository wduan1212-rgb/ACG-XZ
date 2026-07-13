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
INFO_FLOW_STORYBOARD_TIMEOUT_MS = 4 * 60 * 1000
STORYBOARD_RISKY_TERMS = (
    ("写实" + "真人", "2.5D动画角色"),
    ("真人" + "正脸", "动画角色侧影"),
    ("真人" + "半身像", "动画角色半身"),
)

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
  parent_id  TEXT,
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
CREATE TABLE IF NOT EXISTS supplier_account_bindings(
  parent_id  TEXT NOT NULL,
  child_id   TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY(parent_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_supplier_bindings_child ON supplier_account_bindings(child_id);
CREATE TABLE IF NOT EXISTS supplier_activity(
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  child_id    TEXT,
  member_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  account_id  TEXT,
  asset_id    TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_activity_parent ON supplier_activity(parent_id, created_at DESC);
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
            "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) VALUES(?,?,?,?,?,?,?)",
            (uuid.uuid4().hex[:10], "管理员", DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PIN_HASH, "admin", None, now),
        )
        conn.execute(
            "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) VALUES(?,?,?,?,?,?,?)",
            (uuid.uuid4().hex[:10], "供应商", DEFAULT_SUPPLIER_USERNAME, DEFAULT_SUPPLIER_PIN_HASH, "supplier_parent", None, now + 1),
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


def _ensure_supplier_parent_role_locked(conn):
    """旧版曾把默认供应商账号保存为创作成员；只修正角色，不改账号、密码或业务数据。"""
    row = conn.execute("SELECT id,role FROM members WHERE username=?", (DEFAULT_SUPPLIER_USERNAME,)).fetchone()
    if row and row[1] != "supplier_parent":
        conn.execute("UPDATE members SET role='supplier_parent', parent_id=NULL WHERE id=?", (row[0],))


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
            member_cols = {r[1] for r in conn.execute("PRAGMA table_info(members)").fetchall()}
            if "parent_id" not in member_cols:
                conn.execute("ALTER TABLE members ADD COLUMN parent_id TEXT")
            # 旧版 supplier 无子账号概念，安全迁移为供应商母账号。
            conn.execute("UPDATE members SET role='supplier_parent' WHERE role='supplier'")
            _seed_admin_locked(conn)
            _ensure_admin_alias_locked(conn)
            _ensure_supplier_parent_role_locked(conn)
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
    return {"id": row[0], "name": row[1], "username": row[2], "role": row[4], "parentId": row[5] if len(row) > 6 else None, "createdAt": row[6] if len(row) > 6 else row[5]}


def add_member(name, username, pin, role, parent_id=None):
    return add_member_with_hash(name, username, hash_pin(pin), role, parent_id)


def add_member_with_hash(name, username, pin_hash, role, parent_id=None):
    mid = uuid.uuid4().hex[:10]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) VALUES(?,?,?,?,?,?,?)",
                (mid, name, username, pin_hash, role, parent_id, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()
    return get_member(mid)


def get_member(mid):
    return _fetchone("SELECT id,name,username,pin_hash,role,parent_id,created_at FROM members WHERE id=?", (mid,))


def get_member_by_username(username):
    return _fetchone("SELECT id,name,username,pin_hash,role,parent_id,created_at FROM members WHERE username=?", (username,))


def list_members():
    rows = _fetchall("SELECT id,name,username,pin_hash,role,parent_id,created_at FROM members ORDER BY created_at")
    return [_member_public(r) for r in rows]


def update_member(mid, name=None, username=None, role=None, pin=None, parent_id=None):
    sets, vals = [], []
    if name is not None:
        sets.append("name=?"); vals.append(name)
    if username is not None:
        sets.append("username=?"); vals.append(username)
    if role is not None:
        sets.append("role=?"); vals.append(role)
    if parent_id is not None:
        sets.append("parent_id=?"); vals.append(parent_id or None)
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
            conn.execute("DELETE FROM supplier_account_bindings WHERE child_id=? OR parent_id=?", (mid, mid))
            conn.execute("DELETE FROM supplier_activity WHERE child_id=? OR parent_id=? OR member_id=?", (mid, mid, mid))
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


def approve_member_request(rid, reviewer_id, parent_id=None):
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
                "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) VALUES(?,?,?,?,?,?,?)",
                (mid, row[1], row[2], row[3], row[4], parent_id if row[4] == "supplier_child" else None, now),
            )
            conn.execute(
                "UPDATE member_requests SET status='approved', reviewed_at=?, reviewed_by=? WHERE id=?",
                (now, reviewer_id, rid),
            )
            conn.commit()
        finally:
            conn.close()
    return get_member(mid), None


# ---------- 供应商组织：母账号可管理子账号并分配内容账号 ----------
def list_supplier_children(parent_id, include_all=False):
    if include_all:
        rows = _fetchall("SELECT id,name,username,pin_hash,role,parent_id,created_at FROM members WHERE role='supplier_child' ORDER BY created_at")
    else:
        rows = _fetchall("SELECT id,name,username,pin_hash,role,parent_id,created_at FROM members WHERE role='supplier_child' AND parent_id=? ORDER BY created_at", (parent_id,))
    return [_member_public(r) for r in rows]


def supplier_child_for(parent_id, child_id, include_all=False):
    row = get_member(child_id)
    if not row or row[4] != "supplier_child":
        return None
    if not include_all and row[5] != parent_id:
        return None
    return row


def create_supplier_children(parent_id, items):
    made = []
    for item in items or []:
        name = str((item or {}).get("name") or "").strip()
        username = str((item or {}).get("username") or "").strip()
        pin = str((item or {}).get("pin") or "")
        if not name or not username or not pin:
            raise ValueError("missing_fields")
        if get_member_by_username(username):
            raise ValueError("username_exists")
        made.append(member_public(add_member(name, username, pin, "supplier_child", parent_id)))
    return made


def supplier_bindings(parent_id, include_all=False):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            sql = "SELECT parent_id,child_id,account_id,created_at,created_by FROM supplier_account_bindings"
            rows = conn.execute(sql + (" ORDER BY created_at" if include_all else " WHERE parent_id=? ORDER BY created_at"), () if include_all else (parent_id,)).fetchall()
            return [{"parentId": r[0], "childId": r[1], "accountId": r[2], "createdAt": r[3], "createdBy": r[4]} for r in rows]
        finally:
            conn.close()


def supplier_account_ids_for_child(child_id):
    rows = _fetchall("SELECT account_id FROM supplier_account_bindings WHERE child_id=?", (child_id,))
    return {r[0] for r in rows}


def set_supplier_child_accounts(parent_id, child_id, account_ids, actor_id, include_all=False):
    child = supplier_child_for(parent_id, child_id, include_all)
    if not child:
        return False
    actual_parent_id = child[5] or parent_id
    ids = sorted({str(x) for x in (account_ids or []) if str(x)})
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("DELETE FROM supplier_account_bindings WHERE child_id=?", (child_id,))
            now = int(time.time() * 1000)
            for aid in ids:
                # 一个内容账号在同一供应商母账号下只对应一个子账号，新的分配会安全迁移。
                conn.execute("DELETE FROM supplier_account_bindings WHERE parent_id=? AND account_id=?", (actual_parent_id, aid))
                conn.execute("INSERT INTO supplier_account_bindings(parent_id,child_id,account_id,created_at,created_by) VALUES(?,?,?,?,?)", (actual_parent_id, child_id, aid, now, actor_id))
            conn.commit()
        finally:
            conn.close()
    return True


def add_supplier_activity(parent_id, child_id, member_id, action, account_id="", asset_id="", detail=""):
    _ensure_db()
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO supplier_activity(id,parent_id,child_id,member_id,action,account_id,asset_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex[:12], parent_id or None, child_id or None, member_id, str(action or "")[:40], account_id or None, asset_id or None, str(detail or "")[:300], now),
            )
            conn.commit()
        finally:
            conn.close()


def list_supplier_activity(parent_id, include_all=False, limit=80):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            if include_all:
                rows = conn.execute("SELECT id,parent_id,child_id,member_id,action,account_id,asset_id,detail,created_at FROM supplier_activity ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            else:
                rows = conn.execute("SELECT id,parent_id,child_id,member_id,action,account_id,asset_id,detail,created_at FROM supplier_activity WHERE parent_id=? ORDER BY created_at DESC LIMIT ?", (parent_id, limit)).fetchall()
            members = {r[0]: r[1] for r in conn.execute("SELECT id,name FROM members").fetchall()}
            return [{"id": r[0], "parentId": r[1], "childId": r[2], "memberId": r[3], "memberName": members.get(r[3], "成员"), "action": r[4], "accountId": r[5], "assetId": r[6], "detail": r[7] or "", "createdAt": r[8]} for r in rows]
        finally:
            conn.close()


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


def update_supplier_asset_views(asset_id, view_count, member_id, role):
    """供应商观看量专用写入：母账号可更新供应商端交付，子账号仅可更新已分配账号。"""
    if role not in {"supplier_parent", "supplier_child"}:
        return None, "forbidden"
    _ensure_db()
    assigned = supplier_account_ids_for_child(member_id) if role == "supplier_child" else None
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT data,owner_id FROM docs WHERE collection='assets' AND id=?", (str(asset_id),)
            ).fetchone()
            if not row:
                return None, "not_found"
            item = json.loads(row[0])
            if not item.get("delivered") and not item.get("shared"):
                return None, "not_delivered"
            if assigned is not None and item.get("accountId") not in assigned:
                return None, "unassigned"
            now = int(time.time() * 1000)
            item["viewCount"] = max(0, int(view_count or 0))
            item["viewsUpdatedAt"] = now
            item["viewsUpdatedBy"] = member_id
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("assets", str(asset_id), row[1], now, json.dumps(item, ensure_ascii=False)),
            )
            conn.commit()
            return item, None
        finally:
            conn.close()


def _sanitize_storyboard_terms(value):
    if isinstance(value, str):
        out = value
        for source, target in STORYBOARD_RISKY_TERMS:
            out = out.replace(source, target)
        return out
    if isinstance(value, list):
        return [_sanitize_storyboard_terms(v) for v in value]
    if isinstance(value, dict):
        return {k: _sanitize_storyboard_terms(v) for k, v in value.items()}
    return value


def _heal_production_runtime_state(item):
    """修复旧前端遗留的中间态，避免 UI 永久卡在生成中。"""
    if not isinstance(item, dict):
        return item, False
    changed = False
    artifacts = item.get("artifacts") if isinstance(item.get("artifacts"), dict) else {}
    boards = artifacts.get("boards") if isinstance(artifacts.get("boards"), dict) else {}
    info = boards.get("infoFlow") if isinstance(boards.get("infoFlow"), dict) else None
    if not info:
        return item, False
    cleaned = _sanitize_storyboard_terms(info)
    if cleaned != info:
        boards["infoFlow"] = cleaned
        info = cleaned
        changed = True
    if info.get("status") == "storyboarding":
        segments = info.get("segments") if isinstance(info.get("segments"), list) else []
        has_storyboard = bool(info.get("storyboards")) or any(bool((s or {}).get("storyboardAssetIds")) for s in segments if isinstance(s, dict))
        age = int(time.time() * 1000) - int(info.get("updatedAt") or 0)
        if (not info.get("updatedAt")) or ((not has_storyboard) and age > INFO_FLOW_STORYBOARD_TIMEOUT_MS):
            now = int(time.time() * 1000)
            info["status"] = "failed"
            info["error"] = "功能演示分镜生成超时或连接中断，请重试。"
            info["updatedAt"] = now
            item["updatedAt"] = now
            changed = True
    return item, changed


def state_for(member_id, role, parent_id=None):
    """按成员可见性返回快照：创作端按人隔离，供应商子账号只取得已分配账号的交付物。"""
    _ensure_db()
    out = {}
    visible_prod_ids = set()
    assigned_account_ids = supplier_account_ids_for_child(member_id) if role == "supplier_child" else set()
    visible_asset_ids = set()
    supplier_avatar_asset_ids = set()
    supplier_production_created_at = {}
    with _lock:
        conn = _connect()
        try:
            if role in {"supplier_parent", "supplier_child"}:
                production_rows = conn.execute("SELECT id, data FROM docs WHERE collection='productions'").fetchall()
                for production_id, raw_data in production_rows:
                    try:
                        production = json.loads(raw_data)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if role == "supplier_child" and production.get("accountId") not in assigned_account_ids:
                        continue
                    supplier_production_created_at[str(production_id)] = production.get("createdAt")
            for col in COLLECTIONS:
                if role in {"supplier_parent", "supplier_child"} and col not in {"accounts", "assets"}:
                    out[col] = []
                    continue
                rows = conn.execute("SELECT data, owner_id FROM docs WHERE collection=?", (col,)).fetchall()
                items = []
                for data, owner in rows:
                    item = json.loads(data)
                    healed = False
                    if col == "productions":
                        item, healed = _heal_production_runtime_state(item)
                    if col in {"sessions", "batches"} and owner and owner != member_id:
                        continue
                    if col == "accounts" and role == "supplier_child" and item.get("id") not in assigned_account_ids:
                        continue
                    if col == "accounts" and role in {"supplier_parent", "supplier_child"}:
                        if item.get("avatarAssetId"):
                            supplier_avatar_asset_ids.add(item.get("avatarAssetId"))
                        item = {
                            key: item.get(key) for key in (
                                "id", "name", "platform", "mode", "index", "avatarAssetId", "avatarUrl"
                            ) if item.get(key) is not None
                        }
                    if col == "productions":
                        if role == "supplier_child" and (item.get("stage") != "delivered" or item.get("accountId") not in assigned_account_ids):
                            continue
                        if role == "supplier_parent" and item.get("stage") != "delivered":
                            continue
                        if role == "editor" and owner and owner != member_id:
                            continue
                        if role not in {"supplier_child", "supplier_parent", "editor", "admin"} and owner and owner != member_id:
                            continue
                    if col == "assets":
                        if role in {"supplier_parent", "supplier_child"} and not item.get("sourceCreatedAt"):
                            item["sourceCreatedAt"] = supplier_production_created_at.get(str(item.get("productionId") or "")) or item.get("createdAt")
                        is_supplier_avatar = item.get("id") in supplier_avatar_asset_ids
                        if role == "supplier_child" and not is_supplier_avatar and ((not item.get("delivered") and not item.get("shared")) or item.get("accountId") not in assigned_account_ids):
                            continue
                        if role == "supplier_parent" and not is_supplier_avatar and not item.get("delivered") and not item.get("shared"):
                            continue
                        if role == "editor" and item.get("delivered") and item.get("byMemberId") and item.get("byMemberId") != member_id:
                            continue
                        if role not in {"supplier_child", "supplier_parent", "editor", "admin"} and owner and owner != member_id and not item.get("delivered") and not item.get("shared"):
                            continue
                    if col == "voicePresets" and owner and owner != member_id:
                        continue
                    if healed and col == "productions":
                        conn.execute(
                            "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                            (col, str(item.get("id")), item.get("ownerId"), int(item.get("updatedAt") or time.time() * 1000), json.dumps(item, ensure_ascii=False)),
                        )
                    items.append(item)
                out[col] = items
                if col == "productions":
                    visible_prod_ids = {p.get("id") for p in items}
                if col == "assets":
                    visible_asset_ids = {a.get("id") for a in items}
            conn.commit()
        finally:
            conn.close()
    out["jobs"] = [j for j in out.get("jobs", []) if j.get("productionId") in visible_prod_ids]
    if role == "supplier_child":
        out["analyticsLinks"] = [x for x in out.get("analyticsLinks", []) if x.get("assetId") in visible_asset_ids]
    return out
