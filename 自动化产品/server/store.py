"""共享后端存储（Phase 1）：SQLite 文档表 + 成员表 + 口令哈希 + 无状态签名 token。

设计取舍：用「文档表」整条存 JSON，而不是给每类实体逐一建关系表——前端 schema 仍在演进，
文档存零映射、最稳，前端域模型一行不用改。团队规模够用；要扩 Postgres 时把本文件换实现即可（接口不变）。
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from threading import Lock
from urllib.parse import unquote_to_bytes, urlparse

DB_PATH = Path(os.getenv("DATA_DB", Path(__file__).resolve().parent / "data.sqlite"))
CUSTOM_CANVAS_BLOB_DIR = Path(
    os.getenv("CUSTOM_CANVAS_BLOB_DIR", DB_PATH.parent / "canvas_blobs")
)


def _positive_env_int(name, default, minimum=1):
    try:
        return max(int(minimum), int(os.getenv(name, default)))
    except (TypeError, ValueError, OverflowError):
        return int(default)


DEFAULT_ADMIN_USERNAME = os.getenv("DEFAULT_ADMIN_USERNAME") or bytes.fromhex("61646d696e").decode()
DEFAULT_SUPPLIER_USERNAME = os.getenv("DEFAULT_SUPPLIER_USERNAME") or bytes.fromhex("676f6e6779696e677368616e67").decode()
DEFAULT_ADMIN_PIN_HASH = os.getenv("DEFAULT_ADMIN_PIN_HASH") or "pbkdf2$120000$737461722d61727261792d61646d696e2d7631$1d5f7e973e925fb41415dd6b322a3e8d6e3ab272e0c8ce8961393abd9af8edba"
DEFAULT_SUPPLIER_PIN_HASH = os.getenv("DEFAULT_SUPPLIER_PIN_HASH") or "pbkdf2$120000$737461722d61727261792d737570706c6965722d7631$a5b6620381cff96c4602112ab5b3ee89b027d53c263d4452150cc9c7d9d5e1ff"

# 入服务器共享的集合（与前端 db.collections 对齐）。
# notifications / ui / apiKeys 是每设备本地态，不入服务器。
COLLECTIONS = [
    "accounts", "productions", "assets", "sessions", "batches", "jobs",
    "analyticsLinks", "metricSnapshots", "insightReports", "creativeMemory", "products", "voicePresets",
    "customProjects", "customOutputs", "customVideoJobs",
]
# 按 owner 隔离的集合（创作互不干扰）；其余全员共享。jobs 跟随其 production 的可见性。
# voicePresets 是“平台共享选择、所有者/管理员维护”：读取时对创作成员共享，
# 写入和删除仍由专用 owner 校验保护，不能走普通共享集合语义。
OWNED = {
    "productions", "sessions", "batches",
    "customProjects", "customOutputs", "customVideoJobs",
}
CUSTOM_COLLECTIONS = {"customProjects", "customOutputs", "customVideoJobs"}
ADMIN_ONLY_GENERIC_COLLECTIONS = {"accounts", "products"}
OWNER_SCOPED_GENERIC_COLLECTIONS = {
    "productions", "sessions", "batches", "insightReports", "creativeMemory",
}
CUSTOM_PROJECT_KINDS = {"video", "canvas"}
CUSTOM_PROJECT_STATUSES = {"draft", "published", "archived"}
MAX_CUSTOM_PROJECT_STATE_BYTES = 2 * 1024 * 1024
MAX_CUSTOM_CANVAS_PROJECT_BYTES = _positive_env_int(
    "CUSTOM_CANVAS_PROJECT_JSON_MAX_BYTES", 2 * 1024 * 1024, 256 * 1024
)
MAX_CUSTOM_CANVAS_DRAFT_BYTES = _positive_env_int(
    "CUSTOM_CANVAS_DRAFT_JSON_MAX_BYTES", 64 * 1024 * 1024, 1024 * 1024
)
MAX_CUSTOM_CANVAS_BLOB_BYTES = _positive_env_int(
    "CUSTOM_CANVAS_BLOB_MAX_BYTES", 64 * 1024 * 1024, 1024 * 1024
)
MAX_CUSTOM_CANVAS_TOTAL_BLOB_BYTES = _positive_env_int(
    "CUSTOM_CANVAS_PROJECT_BLOBS_MAX_BYTES", 512 * 1024 * 1024, 64 * 1024 * 1024
)
MAX_CUSTOM_CANVAS_OWNER_BLOB_BYTES = _positive_env_int(
    "CUSTOM_CANVAS_OWNER_BLOBS_MAX_BYTES", 2 * 1024 * 1024 * 1024, 512 * 1024 * 1024
)
MAX_CUSTOM_CANVAS_ITEMS = 600
MAX_CUSTOM_CANVAS_MESSAGES = 800
MAX_CUSTOM_CANVAS_BLOBS = 240
CUSTOM_CANVAS_IMAGE_MIMES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
}
CUSTOM_CANVAS_BLOB_REF_TYPE = "custom-canvas-blob-v1"
INFO_FLOW_STORYBOARD_TIMEOUT_MS = 4 * 60 * 1000
STORYBOARD_RISKY_TERMS = (
    ("写实" + "真人", "2.5D动画角色"),
    ("真人" + "正脸", "动画角色侧影"),
    ("真人" + "半身像", "动画角色半身"),
)
ACCOUNT_REFERENCE_ASSET_FIELDS = (
    "avatarAssetId",
    "voiceRefAssetId",
    "seedanceVoiceRefAssetId",
)


def _is_global_editing_asset(item):
    if not isinstance(item, dict):
        return False
    tags = " ".join(str(tag or "") for tag in (item.get("tags") or []))
    asset_type = str(item.get("type") or "")
    if asset_type == "音频":
        explicit_bgm = any(word.lower() in tags.lower() for word in ("bgm", "音乐库", "配乐"))
        explicit_voice = any(
            word.lower() in tags.lower()
            for word in ("口播", "语音", "参考音频库", "tts", "数字人", "声线参考")
        )
        if explicit_bgm:
            return not explicit_voice
        name = str(item.get("name") or "")
        text = f"{tags} {name}"
        return (
            any(word.lower() in name.lower() for word in ("bgm", "音乐库", "配乐"))
            and not any(word.lower() in text.lower() for word in ("口播", "语音", "tts", "数字人", "声线参考"))
        )
    return asset_type in {"图片", "视频"} and any(
        word in tags for word in ("剪辑素材", "共享剪辑素材", "图片素材", "视频素材", "素材库")
    )


def _account_reference_asset_ids(item):
    """账号共享给创作者时，只同步账号必需的管理资产。

    旧版 imageStyleAssetId 仅保留在原账号记录中供无损回滚，不再作为长期参考图
    向创作者下发；数字人角色版仍是唯一生成链路会长期读取的图片。
    """
    if not isinstance(item, dict):
        return set()
    ids = {
        str(item.get(field))
        for field in ACCOUNT_REFERENCE_ASSET_FIELDS
        if item.get(field)
    }
    if (
        item.get("mode") == "视频"
        and item.get("subType") == "数字人"
        and item.get("charBoardAssetId")
    ):
        ids.add(str(item.get("charBoardAssetId")))
    return ids


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
CREATE TABLE IF NOT EXISTS custom_canvas_drafts(
  owner_id          TEXT NOT NULL,
  source_project_id TEXT NOT NULL,
  custom_project_id TEXT NOT NULL,
  revision          INTEGER NOT NULL DEFAULT 1,
  client_updated_at INTEGER NOT NULL DEFAULT 0,
  server_updated_at INTEGER NOT NULL DEFAULT 0,
  content_hash      TEXT NOT NULL,
  project_json      TEXT NOT NULL,
  draft_json        TEXT NOT NULL,
  deleted_at        INTEGER,
  PRIMARY KEY(owner_id, source_project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_canvas_draft_project
  ON custom_canvas_drafts(custom_project_id);
CREATE INDEX IF NOT EXISTS idx_custom_canvas_draft_owner_updated
  ON custom_canvas_drafts(owner_id, server_updated_at DESC);
CREATE TABLE IF NOT EXISTS custom_canvas_blobs(
  owner_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  stored_name  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY(owner_id, content_hash)
);
CREATE TABLE IF NOT EXISTS members(
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  username   TEXT NOT NULL UNIQUE,
  pin_hash   TEXT NOT NULL,
  role       TEXT NOT NULL,
  parent_id  TEXT,
  avatar_url TEXT,
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
CREATE TABLE IF NOT EXISTS password_reset_requests(
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_reset_requests_status_created
  ON password_reset_requests(status, created_at DESC);
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
CREATE TABLE IF NOT EXISTS llm_usage_events(
  id                TEXT PRIMARY KEY,
  member_id         TEXT NOT NULL,
  member_name       TEXT NOT NULL,
  feature           TEXT NOT NULL,
  model             TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_events_member_created
  ON llm_usage_events(member_id, created_at DESC);
CREATE TABLE IF NOT EXISTS api_usage_events(
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL,
  member_name  TEXT NOT NULL,
  api_type     TEXT NOT NULL,
  feature      TEXT NOT NULL,
  model        TEXT,
  calls        INTEGER NOT NULL DEFAULT 1,
  output_units INTEGER NOT NULL DEFAULT 1,
  unit_label   TEXT NOT NULL DEFAULT '任务',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_usage_events_member_created
  ON api_usage_events(member_id, created_at DESC);
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
            if "avatar_url" not in member_cols:
                conn.execute("ALTER TABLE members ADD COLUMN avatar_url TEXT")
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
    return {
        "id": row[0], "name": row[1], "username": row[2], "role": row[4],
        "parentId": row[5] if len(row) > 7 else None,
        "avatarUrl": row[6] if len(row) > 7 else "",
        "createdAt": row[7] if len(row) > 7 else row[5],
    }


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
    return _fetchone("SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members WHERE id=?", (mid,))


def get_member_by_username(username):
    return _fetchone("SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members WHERE username=?", (username,))


def list_members():
    rows = _fetchall("SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members ORDER BY created_at")
    return [_member_public(r) for r in rows]


def update_member(mid, name=None, username=None, role=None, pin=None, parent_id=None, avatar_url=None):
    sets, vals = [], []
    if name is not None:
        sets.append("name=?"); vals.append(name)
    if username is not None:
        sets.append("username=?"); vals.append(username)
    if role is not None:
        sets.append("role=?"); vals.append(role)
    if parent_id is not None:
        sets.append("parent_id=?"); vals.append(parent_id or None)
    if avatar_url is not None:
        sets.append("avatar_url=?"); vals.append(str(avatar_url or "")[:600])
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


# ---------- 密码找回申请 ----------
def _password_reset_request_public(row):
    return {
        "id": row[0],
        "name": row[1],
        "status": row[2],
        "createdAt": row[3],
    }


def add_password_reset_request(name):
    clean_name = re.sub(r"\s+", " ", str(name or "")).strip()[:80]
    now = int(time.time() * 1000)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            # Repeated clicks within ten minutes should not flood the admin bell.
            row = conn.execute(
                "SELECT id,name,status,created_at FROM password_reset_requests "
                "WHERE name=? AND status='pending' AND created_at>=? ORDER BY created_at DESC LIMIT 1",
                (clean_name, now - 10 * 60 * 1000),
            ).fetchone()
            if not row:
                rid = uuid.uuid4().hex[:12]
                conn.execute(
                    "INSERT INTO password_reset_requests(id,name,status,created_at) VALUES(?,?,?,?)",
                    (rid, clean_name, "pending", now),
                )
                conn.commit()
                row = conn.execute(
                    "SELECT id,name,status,created_at FROM password_reset_requests WHERE id=?",
                    (rid,),
                ).fetchone()
        finally:
            conn.close()
    return _password_reset_request_public(row)


def list_password_reset_requests(status="pending"):
    _ensure_db()
    if status:
        rows = _fetchall(
            "SELECT id,name,status,created_at FROM password_reset_requests "
            "WHERE status=? ORDER BY created_at DESC",
            (status,),
        )
    else:
        rows = _fetchall(
            "SELECT id,name,status,created_at FROM password_reset_requests ORDER BY created_at DESC"
        )
    return [_password_reset_request_public(row) for row in rows]


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
        rows = _fetchall("SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members WHERE role='supplier_child' ORDER BY created_at")
    else:
        rows = _fetchall("SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members WHERE role='supplier_child' AND parent_id=? ORDER BY created_at", (parent_id,))
    return [_member_public(r) for r in rows]


def list_supplier_members():
    """供应商管理员共享同一组织视图：可见全部管理员与子账号。"""
    rows = _fetchall(
        "SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members "
        "WHERE role IN ('supplier_parent','supplier_child') "
        "ORDER BY CASE role WHEN 'supplier_parent' THEN 0 ELSE 1 END, created_at"
    )
    return [_member_public(r) for r in rows]


def supplier_child_for(parent_id, child_id, include_all=False):
    row = get_member(child_id)
    if not row or row[4] != "supplier_child":
        return None
    if not include_all and row[5] != parent_id:
        return None
    return row


def create_supplier_children(parent_id, items):
    normalized = []
    for item in items or []:
        name = str((item or {}).get("name") or "").strip()
        username = str((item or {}).get("username") or "").strip()
        pin = str((item or {}).get("pin") or "")
        if not name or not username or not pin:
            raise ValueError("missing_fields")
        normalized.append((name, username, pin))
    usernames = [row[1].lower() for row in normalized]
    if len(set(usernames)) != len(usernames):
        raise ValueError("username_exists")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            for _name, username, _pin in normalized:
                if conn.execute("SELECT 1 FROM members WHERE lower(username)=lower(?)", (username,)).fetchone():
                    raise ValueError("username_exists")
            made = []
            now = int(time.time() * 1000)
            for index, (name, username, pin) in enumerate(normalized):
                mid = uuid.uuid4().hex[:10]
                conn.execute(
                    "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) VALUES(?,?,?,?,?,?,?)",
                    (mid, name, username, hash_pin(pin), "supplier_child", parent_id, now + index),
                )
                made.append({
                    "id": mid, "name": name, "username": username,
                    "role": "supplier_child", "parentId": parent_id, "createdAt": now + index,
                })
            conn.commit()
            return made
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


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


# ---------- 语言模型用量（仅记录上游响应中可核验的 token 字段） ----------
def _usage_int(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def record_llm_usage(member_id, member_name, feature, model, usage):
    """持久化一次已成功的语言模型调用的 token 用量。

    上游未返回 usage 时不写入，避免将猜测值误标为 API 积分或账单金额。
    """
    source = usage if isinstance(usage, dict) else {}
    prompt = _usage_int(source.get("prompt_tokens", source.get("input_tokens")))
    completion = _usage_int(source.get("completion_tokens", source.get("output_tokens")))
    total = _usage_int(source.get("total_tokens")) or prompt + completion
    if not (prompt or completion or total):
        return False
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO llm_usage_events(id,member_id,member_name,feature,model,prompt_tokens,completion_tokens,total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex[:16], str(member_id or ""), str(member_name or "成员")[:120],
                    str(feature or "通用调用")[:80], str(model or "")[:160], prompt, completion, total,
                    int(time.time() * 1000),
                ),
            )
            conn.commit()
            return True
        finally:
            conn.close()


def llm_usage_summary():
    """管理员只读汇总；列出管理员与创作成员，即使尚无可统计调用。"""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT m.id,m.name,m.username,m.role,"
                "COALESCE(SUM(u.prompt_tokens),0) AS prompt_tokens,"
                "COALESCE(SUM(u.completion_tokens),0) AS completion_tokens,"
                "COALESCE(SUM(u.total_tokens),0) AS total_tokens,"
                "COUNT(u.id) AS calls,MAX(u.created_at) AS last_used_at "
                "FROM members m LEFT JOIN llm_usage_events u ON u.member_id=m.id "
                "WHERE m.role IN ('admin','editor') "
                "GROUP BY m.id,m.name,m.username,m.role ORDER BY total_tokens DESC,m.created_at ASC"
            ).fetchall()
            return [{
                "memberId": row[0], "memberName": row[1], "username": row[2], "role": row[3],
                "promptTokens": int(row[4] or 0), "completionTokens": int(row[5] or 0),
                "totalTokens": int(row[6] or 0), "calls": int(row[7] or 0), "lastUsedAt": row[8],
            } for row in rows]
        finally:
            conn.close()


def record_api_usage(member_id, member_name, api_type, feature, model, output_units=1, unit_label="任务"):
    """记录一次已被上游接受的非 Token 模型调用。

    图片、视频等接口通常不会返回可核验的 token usage，因而只记录真实成功请求和
    实际输出单位，绝不把调用次数换算或伪装成 token / 金额。
    """
    kind = str(api_type or "").strip().lower()
    if kind not in {"image", "video", "voice"}:
        return False
    try:
        units = max(0, int(output_units or 0))
    except (TypeError, ValueError, OverflowError):
        units = 0
    if units <= 0:
        return False
    label = str(unit_label or "任务").strip()[:24] or "任务"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO api_usage_events(id,member_id,member_name,api_type,feature,model,calls,output_units,unit_label,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex[:16], str(member_id or ""), str(member_name or "成员")[:120],
                    kind, str(feature or "模型调用")[:80], str(model or "")[:160], 1, units, label,
                    int(time.time() * 1000),
                ),
            )
            conn.commit()
            return True
        finally:
            conn.close()


def model_usage_summary():
    """按成员汇总真实语言 Token 与非 Token 的图片/视频调用账本。"""
    rows = {row["memberId"]: row for row in llm_usage_summary()}
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            api_rows = conn.execute(
                "SELECT m.id,m.name,m.username,m.role,u.api_type,"
                "COALESCE(SUM(u.calls),0),COALESCE(SUM(u.output_units),0),MAX(u.created_at) "
                "FROM members m LEFT JOIN api_usage_events u ON u.member_id=m.id "
                "WHERE m.role IN ('admin','editor') "
                "GROUP BY m.id,m.name,m.username,m.role,u.api_type"
            ).fetchall()
        finally:
            conn.close()
    for member_id, member_name, username, role, api_type, calls, outputs, last_used_at in api_rows:
        row = rows.setdefault(member_id, {
            "memberId": member_id, "memberName": member_name, "username": username, "role": role,
            "promptTokens": 0, "completionTokens": 0, "totalTokens": 0, "calls": 0, "lastUsedAt": None,
        })
        if not api_type:
            continue
        prefix = {"image": "image", "video": "video", "voice": "voice"}.get(api_type, "")
        if not prefix:
            continue
        row[f"{prefix}Calls"] = int(calls or 0)
        row[f"{prefix}Outputs"] = int(outputs or 0)
        row[f"{prefix}LastUsedAt"] = last_used_at
    for row in rows.values():
        for key in ("imageCalls", "imageOutputs", "videoCalls", "videoOutputs", "voiceCalls", "voiceOutputs"):
            row.setdefault(key, 0)
    return sorted(rows.values(), key=lambda row: (
        -int(row.get("totalTokens") or 0),
        -(int(row.get("imageCalls") or 0) + int(row.get("videoCalls") or 0) + int(row.get("voiceCalls") or 0)),
        str(row.get("memberName") or ""),
    ))


def llm_usage_details(limit=120, member_id=""):
    """管理员用的调用明细：按功能 / 模型汇总，并保留最近可核验的原始记录。

    明细只来自上游响应的 usage 字段；不把图片、视频、语音或没有 usage 的请求估算成 token。
    """
    try:
        limit = max(1, min(int(limit or 120), 500))
    except (TypeError, ValueError, OverflowError):
        limit = 120
    member_id = str(member_id or "").strip()
    where = "WHERE u.member_id=?" if member_id else ""
    params = (member_id,) if member_id else ()
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            api_rows = conn.execute(
                "SELECT feature,COALESCE(model,''),COUNT(id) AS calls,"
                "COALESCE(SUM(prompt_tokens),0),COALESCE(SUM(completion_tokens),0),"
                "COALESCE(SUM(total_tokens),0) AS total_tokens,MAX(created_at) AS last_used_at "
                "FROM llm_usage_events u " + where + " "
                "GROUP BY feature,COALESCE(model,'') "
                "ORDER BY total_tokens DESC,last_used_at DESC,feature ASC"
                , params
            ).fetchall()
            events = conn.execute(
                "SELECT u.id,u.member_id,u.member_name,COALESCE(m.username,''),u.feature,"
                "COALESCE(u.model,''),u.prompt_tokens,u.completion_tokens,u.total_tokens,u.created_at "
                "FROM llm_usage_events u LEFT JOIN members m ON m.id=u.member_id " + where + " "
                "ORDER BY u.created_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
            return {
                "apiRows": [{
                    "feature": row[0], "model": row[1], "calls": int(row[2] or 0),
                    "promptTokens": int(row[3] or 0), "completionTokens": int(row[4] or 0),
                    "totalTokens": int(row[5] or 0), "lastUsedAt": row[6],
                } for row in api_rows],
                "events": [{
                    "id": row[0], "memberId": row[1], "memberName": row[2], "username": row[3],
                    "feature": row[4], "model": row[5], "promptTokens": int(row[6] or 0),
                    "completionTokens": int(row[7] or 0), "totalTokens": int(row[8] or 0), "createdAt": row[9],
                } for row in events],
            }
        finally:
            conn.close()


def model_usage_details(member_id="", limit=120):
    """管理员明细：语言 Token 与实际图片/视频调用分开展示。"""
    try:
        limit = max(1, min(int(limit or 120), 500))
    except (TypeError, ValueError, OverflowError):
        limit = 120
    details = llm_usage_details(limit, member_id)
    member_id = str(member_id or "").strip()
    _ensure_db()
    where = "WHERE u.member_id=?" if member_id else ""
    params = (member_id,) if member_id else ()
    with _lock:
        conn = _connect()
        try:
            api_rows = conn.execute(
                "SELECT u.api_type,u.feature,COALESCE(u.model,''),COUNT(u.id),"
                "COALESCE(SUM(u.calls),0),COALESCE(SUM(u.output_units),0),u.unit_label,MAX(u.created_at) "
                "FROM api_usage_events u " + where + " "
                "GROUP BY u.api_type,u.feature,COALESCE(u.model,''),u.unit_label "
                "ORDER BY MAX(u.created_at) DESC,u.api_type ASC,u.feature ASC",
                params,
            ).fetchall()
            events = conn.execute(
                "SELECT u.id,u.member_id,u.member_name,COALESCE(m.username,''),u.api_type,u.feature,"
                "COALESCE(u.model,''),u.calls,u.output_units,u.unit_label,u.created_at "
                "FROM api_usage_events u LEFT JOIN members m ON m.id=u.member_id " + where + " "
                "ORDER BY u.created_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
        finally:
            conn.close()
    details["assetApiRows"] = [{
        "apiType": row[0], "feature": row[1], "model": row[2], "events": int(row[3] or 0),
        "calls": int(row[4] or 0), "outputUnits": int(row[5] or 0), "unitLabel": row[6] or "任务",
        "lastUsedAt": row[7],
    } for row in api_rows]
    details["assetEvents"] = [{
        "id": row[0], "memberId": row[1], "memberName": row[2], "username": row[3],
        "apiType": row[4], "feature": row[5], "model": row[6], "calls": int(row[7] or 0),
        "outputUnits": int(row[8] or 0), "unitLabel": row[9] or "任务", "createdAt": row[10],
    } for row in events]
    return details


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


def _upsert_docs_in_conn(conn, collection, items):
    deleted_ids = {
        r[0] for r in conn.execute("SELECT id FROM deleted_docs WHERE collection=?", (collection,)).fetchall()
    }
    if collection == "accounts":
        _guard_suspicious_account_bulk(conn, items or [])
        semantic_keys = _existing_account_keys(conn)
    else:
        semantic_keys = {}
    written = 0
    for raw in items or []:
        if not isinstance(raw, dict) or "id" not in raw:
            continue
        # 授权层可能需要覆盖 ownerId；复制后写入，避免修改调用方的前端快照。
        it = dict(raw)
        if collection == "assets":
            # /api/state 附加的序号字段都只读；旧浏览器回推整条资产时不得
            # 将投影或全局显示序号固化回生产数据。
            it.pop("projectedSeq", None)
            it.pop("globalSeq", None)
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
            "SELECT updated_at,data FROM docs WHERE collection=? AND id=?", (collection, doc_id)
        ).fetchone()
        if cur and cur[0] > ua:
            continue  # 服务器已有更新的版本，跳过（避免旧端覆盖新数据）
        if collection == "assets" and cur:
            # 备注、下载与观看量由专用原子接口维护。旧浏览器回推整条资产时，
            # 不允许缺字段的本地快照把这些服务器权威字段清掉。
            try:
                existing = json.loads(cur[1])
            except Exception:
                existing = {}
            for key in (
                "remarks", "remarkReadAt", "latestRemarkAt",
                "supplierDownloadedAt", "supplierDownloadedBy",
                "viewsUpdatedAt", "viewsUpdatedBy", "viewCount",
            ):
                if key not in it and key in existing:
                    it[key] = existing[key]
            # 供应商回传链接由专用原子接口维护。即使旧浏览器随后回推了一条
            # 含旧 publishedUrl/status 的完整资产，也不能把较新的回传结果覆盖掉。
            server_published_at = int(existing.get("publishedUpdatedAt") or existing.get("publishedAt") or 0)
            client_published_at = int(it.get("publishedUpdatedAt") or it.get("publishedAt") or 0)
            if server_published_at and server_published_at > client_published_at:
                for key in (
                    "publishedUrl", "supplierNote", "publishedTitle", "publishedRawText",
                    "publishedAt", "publishedUpdatedAt", "publishedUpdatedBy", "publishedClearedAt", "status",
                ):
                    if key in existing:
                        it[key] = existing[key]
                    else:
                        # A supplier may explicitly clear a mistaken return
                        # link.  Do not let an older full-client snapshot put
                        # that URL back merely because the cleared record no
                        # longer carries the optional published fields.
                        it.pop(key, None)
            # 发布清单编号是全局账本字段。完成历史校准后，任何旧浏览器的
            # 整条快照回推都不能把服务端已经确认的编号改回按个人计数的旧值。
            if existing.get("delivered"):
                existing_pub_seq = _int_at_least_zero(existing.get("pubSeq"))
                if existing_pub_seq:
                    it["pubSeq"] = existing_pub_seq
        elif collection == "assets" and it.get("delivered") and _delivery_sequences_reconciled(conn):
            # 新交付也必须由共享账本分配编号，不能信任旧前端的本地计数器。
            it["pubSeq"] = _next_delivery_pub_seq(conn)
        conn.execute(
            "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            (collection, doc_id, it.get("ownerId"), ua, json.dumps(it, ensure_ascii=False)),
        )
        written += 1
        if collection == "accounts":
            key = _account_semantic_key(it)
            if key:
                semantic_keys[key] = doc_id
    return written


def upsert_docs(collection, items):
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            written = _upsert_docs_in_conn(conn, collection, items)
            conn.commit()
            return written
        finally:
            conn.close()


def _same_doc_payload(left, right):
    try:
        return json.dumps(left, ensure_ascii=False, sort_keys=True, separators=(",", ":")) == json.dumps(
            right, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
    except (TypeError, ValueError):
        return False


def _doc_row_in_conn(conn, collection, doc_id):
    row = conn.execute(
        "SELECT owner_id,data FROM docs WHERE collection=? AND id=?",
        (collection, str(doc_id)),
    ).fetchone()
    if not row:
        return None
    try:
        item = json.loads(row[1])
    except (TypeError, json.JSONDecodeError):
        item = {}
    return row[0], item


def _stored_owner(row):
    if not row:
        return ""
    return str(row[0] or row[1].get("ownerId") or "")


def _production_owned_by(conn, production_id, actor):
    if not production_id:
        return False
    return _stored_owner(_doc_row_in_conn(conn, "productions", production_id)) == str(actor)


def _asset_writable_by(conn, asset_id, actor):
    row = _doc_row_in_conn(conn, "assets", asset_id)
    if not row:
        return False
    owner = _stored_owner(row)
    item = row[1]
    if owner == str(actor) or str(item.get("byMemberId") or "") == str(actor):
        return True
    return _production_owned_by(conn, item.get("productionId"), actor)


def _asset_reference_protection_locked(conn, asset_id, item):
    """删除参考资产时的服务端保护线。

    受保护项必须经对应业务链路撤回/替换，不允许普通资产删除直接破坏：
    账号头像、数字人角色版、已发布生成图，以及交付记录的封面/图集依赖。
    """
    aid = str(asset_id or "")
    if not aid:
        return "missing"
    text = " ".join([
        str(item.get("name") or ""),
        " ".join(str(tag or "") for tag in (item.get("tags") or [])),
    ])
    if item.get("delivered") or item.get("shared") or any(
        marker in text for marker in ("已发布生成图", "站内生成", "笔记图", "共享素材")
    ):
        return "published_asset"

    account_rows = conn.execute(
        "SELECT data FROM docs WHERE collection='accounts'"
    ).fetchall()
    for (raw,) in account_rows:
        try:
            account = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if str(account.get("avatarAssetId") or "") == aid:
            return "account_avatar"
        if (
            account.get("mode") == "视频"
            and account.get("subType") == "数字人"
            and str(account.get("charBoardAssetId") or "") == aid
        ):
            return "digital_role_board"

    delivery_rows = conn.execute(
        "SELECT data FROM docs WHERE collection='assets'"
    ).fetchall()
    for (raw,) in delivery_rows:
        try:
            delivery = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if not delivery.get("delivered"):
            continue
        if str(delivery.get("coverAssetId") or "") == aid:
            return "delivery_cover"
        if aid in {str(value) for value in (delivery.get("packAssetIds") or []) if value}:
            return "delivery_pack"
    return ""


def _legacy_style_reference_bound_locked(conn, asset_id):
    """仅用于允许创作者清理旧版管理员绑定的图文风格图。"""
    aid = str(asset_id or "")
    rows = conn.execute("SELECT data FROM docs WHERE collection='accounts'").fetchall()
    for (raw,) in rows:
        try:
            account = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if str(account.get("imageStyleAssetId") or "") == aid:
            return True
    return False


def _editor_can_delete_reference_asset_locked(conn, asset_id, actor):
    row = _doc_row_in_conn(conn, "assets", asset_id)
    if not row:
        return True
    item = row[1]
    if _asset_reference_protection_locked(conn, asset_id, item):
        return False
    if _stored_owner(row) == str(actor):
        return True
    return (
        item.get("type") == "图片"
        and _legacy_style_reference_bound_locked(conn, asset_id)
    )


def _clear_legacy_style_reference_locked(conn, asset_id):
    """资产被允许删除时原子清除旧绑定，不触碰其他账号字段。"""
    aid = str(asset_id or "")
    rows = conn.execute(
        "SELECT id,owner_id,updated_at,data FROM docs WHERE collection='accounts'"
    ).fetchall()
    for account_id, owner_id, updated_at, raw in rows:
        try:
            account = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if str(account.get("imageStyleAssetId") or "") != aid:
            continue
        account["imageStyleAssetId"] = None
        account["updatedAt"] = max(int(account.get("updatedAt") or 0), int(time.time() * 1000))
        conn.execute(
            "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            (
                "accounts",
                str(account_id),
                owner_id,
                max(int(updated_at or 0), int(account["updatedAt"])),
                json.dumps(account, ensure_ascii=False),
            ),
        )


def _analytics_link_writable_by(conn, link_id, actor):
    row = _doc_row_in_conn(conn, "analyticsLinks", link_id)
    if not row:
        return False
    item = row[1]
    references = []
    if item.get("assetId") and _doc_row_in_conn(conn, "assets", item.get("assetId")):
        references.append(_asset_writable_by(conn, item.get("assetId"), actor))
    if item.get("productionId") and _doc_row_in_conn(conn, "productions", item.get("productionId")):
        references.append(_production_owned_by(conn, item.get("productionId"), actor))
    # 上游还存在时必须全部同属 actor；只有交付/production 已回撤后，才回退到
    # 服务端早先写入的 ownerId，保证清理孤立分析记录仍可完成。
    return all(references) if references else _stored_owner(row) == str(actor)


def _snapshot_writable_by(conn, snapshot_id, actor):
    row = _doc_row_in_conn(conn, "metricSnapshots", snapshot_id)
    if not row:
        return False
    link_id = row[1].get("linkId")
    if link_id and _doc_row_in_conn(conn, "analyticsLinks", link_id):
        return _analytics_link_writable_by(conn, link_id, actor)
    return _stored_owner(row) == str(actor)


def _report_writable_by(conn, report_id, actor):
    row = _doc_row_in_conn(conn, "insightReports", report_id)
    if not row:
        return False
    if _stored_owner(row) == str(actor):
        return True
    snapshot_ids = [str(x) for x in (row[1].get("linkedSnapshotIds") or []) if x]
    return bool(snapshot_ids) and all(_snapshot_writable_by(conn, sid, actor) for sid in snapshot_ids)


def _editor_can_upsert(conn, collection, incoming, existing_row, actor):
    """校验 editor 的单条通用回推。

    ownerId 永远由服务端覆盖；关联型集合还必须绑定当前成员已有权限的上游记录，
    因而不能靠伪造 ownerId / productionId / assetId 抢占他人数据。
    """
    existing = existing_row[1] if existing_row else None
    if collection in {"productions", "sessions", "batches"}:
        return existing_row is None or _stored_owner(existing_row) == actor
    if collection == "jobs":
        production_id = str((existing or incoming).get("productionId") or "")
        if existing and str(incoming.get("productionId") or "") != production_id:
            return False
        return _production_owned_by(conn, production_id, actor)
    if collection == "analyticsLinks":
        if existing:
            for key in ("assetId", "productionId"):
                old_value = str(existing.get(key) or "")
                new_value = str(incoming.get(key) or "")
                if old_value and new_value != old_value:
                    return False
            return _analytics_link_writable_by(conn, incoming["id"], actor)
        references = []
        if incoming.get("assetId"):
            references.append(_asset_writable_by(conn, incoming.get("assetId"), actor))
        if incoming.get("productionId"):
            references.append(_production_owned_by(conn, incoming.get("productionId"), actor))
        return bool(references) and all(references)
    if collection == "metricSnapshots":
        link_id = str((existing or incoming).get("linkId") or "")
        if existing and str(incoming.get("linkId") or "") != link_id:
            return False
        return _analytics_link_writable_by(conn, link_id, actor)
    if collection == "insightReports":
        if existing_row and _stored_owner(existing_row) == actor:
            pass
        elif existing_row and not _report_writable_by(conn, incoming["id"], actor):
            return False
        snapshot_ids = [str(x) for x in (incoming.get("linkedSnapshotIds") or []) if x]
        return all(_snapshot_writable_by(conn, sid, actor) for sid in snapshot_ids)
    if collection == "creativeMemory":
        if existing:
            old_report = str(existing.get("sourceReportId") or "")
            new_report = str(incoming.get("sourceReportId") or "")
            if old_report and new_report != old_report:
                return False
            if _stored_owner(existing_row) == actor:
                return not new_report or _report_writable_by(conn, new_report, actor)
            return bool(old_report) and _report_writable_by(conn, old_report, actor)
        source_report_id = str(incoming.get("sourceReportId") or "")
        return not source_report_id or _report_writable_by(conn, source_report_id, actor)
    return False


def upsert_member_collection(owner_id, role, collection, items):
    """通用同步权限矩阵。

    管理员保留全量管理；editor 只能写本人 owner 数据或可验证的交付分析链。
    全量前端快照中的未变化外部记录会被安全忽略；若请求只包含越权修改则拒绝。
    """
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    if role == "admin":
        written = upsert_docs(collection, items)
        return {"written": written, "denied": 0, "unchanged": 0}
    if role != "editor" or collection in ADMIN_ONLY_GENERIC_COLLECTIONS:
        raise PermissionError("forbidden")
    if collection in CUSTOM_COLLECTIONS or collection in {"assets", "voicePresets"}:
        raise PermissionError("use_specialized_writer")

    actor = str(owner_id)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            allowed = []
            denied = 0
            unchanged = 0
            for raw in items or []:
                if not isinstance(raw, dict) or not raw.get("id"):
                    continue
                incoming = dict(raw)
                doc_id = str(incoming["id"])
                existing_row = _doc_row_in_conn(conn, collection, doc_id)
                if not _editor_can_upsert(conn, collection, incoming, existing_row, actor):
                    if existing_row and _same_doc_payload(existing_row[1], incoming):
                        unchanged += 1
                    else:
                        denied += 1
                    continue
                incoming["ownerId"] = actor
                allowed.append(incoming)
            if denied and not allowed:
                raise PermissionError("forbidden")
            written = _upsert_docs_in_conn(conn, collection, allowed)
            conn.commit()
            return {"written": written, "denied": denied, "unchanged": unchanged}
        finally:
            conn.close()


def upsert_member_assets(owner_id, role, items):
    """创作成员只能新建/更新自己的私有资产；管理员保持原管理能力。

    前端保存 assets 时会携带当前快照中的共享 BGM 等其他成员记录，所以对完全
    未改变的他人记录只跳过，不把一次正常保存误判为越权；任何字段变化仍拒绝。
    """
    if role == "admin":
        return {"written": upsert_docs("assets", items), "denied": 0}
    if role != "editor":
        raise PermissionError("forbidden")
    actor = str(owner_id)
    incoming = [dict(item) for item in (items or []) if isinstance(item, dict) and item.get("id")]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            allowed = []
            denied = 0
            for item in incoming:
                doc_id = str(item["id"])
                row = conn.execute(
                    "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                    (doc_id,),
                ).fetchone()
                if row:
                    try:
                        existing = json.loads(row[1])
                    except (TypeError, json.JSONDecodeError):
                        existing = {}
                    stored_owner = str(row[0] or existing.get("ownerId") or "")
                    if stored_owner != actor:
                        if _same_doc_payload(existing, item):
                            continue
                        # A creator snapshot can contain shared assets that have since
                        # changed on the server. Keep those assets immutable, but do
                        # not discard the creator's own newly generated assets in the
                        # same batch.
                        denied += 1
                        continue
                item["ownerId"] = actor
                allowed.append(item)
        finally:
            conn.close()
    # A request containing only a foreign mutation is still an authorization
    # failure. Mixed snapshots may safely persist the creator-owned subset.
    if denied and not allowed:
        raise PermissionError("forbidden")
    return {
        "written": upsert_docs("assets", allowed) if allowed else 0,
        "denied": denied,
    }


def upsert_voice_presets(owner_id, role, items):
    """定制音色全平台可选，但只有原创建者或管理员能修改。"""
    if role not in {"admin", "editor"}:
        raise PermissionError("forbidden")
    actor = str(owner_id)
    incoming = [dict(item) for item in (items or []) if isinstance(item, dict) and item.get("id")]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            allowed = []
            for item in incoming:
                doc_id = str(item["id"])
                row = conn.execute(
                    "SELECT owner_id,data FROM docs WHERE collection='voicePresets' AND id=?",
                    (doc_id,),
                ).fetchone()
                if row:
                    try:
                        existing = json.loads(row[1])
                    except (TypeError, json.JSONDecodeError):
                        existing = {}
                    stored_owner = str(row[0] or existing.get("ownerId") or "")
                    if role != "admin" and stored_owner != actor:
                        if _same_doc_payload(existing, item):
                            continue
                        raise PermissionError("forbidden")
                    item["ownerId"] = stored_owner or actor
                else:
                    item["ownerId"] = actor
                allowed.append(item)
        finally:
            conn.close()
    if allowed:
        upsert_docs("voicePresets", allowed)


def list_voice_presets():
    """Return the shared custom-voice catalog for server-side integrations.

    Preview audio can be large and is irrelevant to TTS routing, so this helper
    deliberately returns only the safe metadata needed to select a voice ID.
    """
    rows = _fetchall(
        "SELECT owner_id,data,updated_at FROM docs WHERE collection='voicePresets'"
    )
    presets = []
    for owner_id, raw_data, updated_at in rows:
        try:
            item = json.loads(raw_data)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(item, dict):
            continue
        voice_id = str(item.get("voiceId") or "").strip()
        if not voice_id:
            continue
        presets.append({
            "id": str(item.get("id") or voice_id),
            "voiceId": voice_id,
            "name": str(item.get("name") or voice_id).strip()[:120],
            "ownerId": str(item.get("ownerId") or owner_id or "").strip(),
            "createdAt": int(item.get("createdAt") or 0),
            "updatedAt": int(item.get("updatedAt") or updated_at or 0),
        })
    return sorted(
        presets,
        key=lambda item: (item["updatedAt"], item["createdAt"], item["id"]),
        reverse=True,
    )


def delete_member_doc(collection, doc_id, member_id, role, protect_custom_delivery=False):
    """通用删除同样执行 actor 校验，避免 DELETE 绕过 PUT 的权限矩阵。"""
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    if role == "admin":
        delete_doc(collection, doc_id, protect_custom_delivery=protect_custom_delivery)
        return
    if role != "editor" or collection in ADMIN_ONLY_GENERIC_COLLECTIONS:
        raise PermissionError("forbidden")
    actor = str(member_id)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = _doc_row_in_conn(conn, collection, doc_id)
            if not row:
                return
            allowed = False
            if collection in {"assets", "voicePresets"} | OWNER_SCOPED_GENERIC_COLLECTIONS:
                allowed = (
                    _editor_can_delete_reference_asset_locked(conn, doc_id, actor)
                    if collection == "assets"
                    else _stored_owner(row) == actor
                )
                if collection == "insightReports" and not allowed:
                    allowed = _report_writable_by(conn, doc_id, actor)
                elif collection == "creativeMemory" and not allowed:
                    source_report_id = str(row[1].get("sourceReportId") or "")
                    allowed = bool(source_report_id) and _report_writable_by(conn, source_report_id, actor)
            elif collection == "jobs":
                production_id = row[1].get("productionId")
                production_exists = bool(_doc_row_in_conn(conn, "productions", production_id))
                allowed = (
                    _production_owned_by(conn, production_id, actor)
                    if production_exists
                    else _stored_owner(row) == actor
                )
            elif collection == "analyticsLinks":
                allowed = _analytics_link_writable_by(conn, doc_id, actor)
            elif collection == "metricSnapshots":
                allowed = _snapshot_writable_by(conn, doc_id, actor)
            if not allowed:
                raise PermissionError("forbidden")

            # production 与其 jobs 是同一权限域。先删除关联 jobs，可避免前端并发
            # DELETE 中 production 先到达导致后续 job 因找不到上游而遗留。
            if collection == "productions":
                job_rows = conn.execute(
                    "SELECT id,data FROM docs WHERE collection='jobs'"
                ).fetchall()
                for job_id, raw in job_rows:
                    try:
                        job = json.loads(raw)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if str(job.get("productionId") or "") == str(doc_id):
                        _delete_doc_in_conn(conn, "jobs", job_id)
            if collection == "assets":
                _clear_legacy_style_reference_locked(conn, doc_id)
            _delete_doc_in_conn(
                conn,
                collection,
                doc_id,
                protect_custom_delivery=protect_custom_delivery,
            )
            conn.commit()
        finally:
            conn.close()


def can_write_asset_file(asset_id, member_id, role):
    """文件上传覆盖前检查同 ID 资产归属；新 ID 可由当前创作者创建。"""
    if role == "admin":
        return True
    if role in {"supplier_parent", "supplier"}:
        # 供应商管理员只能为之后由专用账号 API 绑定的新资产上传文件；
        # 已存在的资产仍不允许从通用文件口覆盖。
        return not bool(_fetchone(
            "SELECT 1 FROM docs WHERE collection='assets' AND id=?",
            (str(asset_id),),
        ))
    if role != "editor":
        return False
    row = _fetchone(
        "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
        (str(asset_id),),
    )
    if not row:
        return True
    try:
        item = json.loads(row[1])
    except (TypeError, json.JSONDecodeError):
        item = {}
    return str(row[0] or item.get("ownerId") or "") == str(member_id)


def can_delete_asset_file(filename, member_id, role):
    """文件删除与资产记录使用同一权限和交付保护规则。"""
    if role == "admin":
        return True
    if role != "editor":
        return False
    target = str(filename or "")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id,data FROM docs WHERE collection='assets'"
            ).fetchall()
            for asset_id, raw in rows:
                try:
                    item = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                file_name = str(item.get("serverFileName") or "")
                file_url = str(item.get("fileUrl") or item.get("url") or "")
                if file_name == target or file_url.endswith("/" + target):
                    return _editor_can_delete_reference_asset_locked(
                        conn, asset_id, member_id
                    )
        finally:
            conn.close()
    return target.startswith(f"{member_id}--")


def _custom_project_row(project_id, conn):
    row = conn.execute(
        "SELECT owner_id,data FROM docs WHERE collection='customProjects' AND id=?",
        (str(project_id),),
    ).fetchone()
    if not row:
        return None
    try:
        item = json.loads(row[1])
    except (TypeError, json.JSONDecodeError):
        return None
    return row[0], item


def _published_custom_delivery_counts_locked(conn, owner_id):
    """按当前 owner 的未回撤真实交付统计每个定制项目累计发布数。"""
    owner = str(owner_id or "")
    counts = {}
    rows = conn.execute(
        """
        SELECT d.id,d.owner_id,d.data
        FROM docs AS d
        WHERE d.collection='assets'
          AND d.owner_id=?
          AND NOT EXISTS (
            SELECT 1
            FROM deleted_docs AS x
            WHERE x.collection='assets' AND x.id=d.id
          )
        """,
        (owner,),
    ).fetchall()
    for _asset_id, row_owner, raw in rows:
        try:
            item = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        project_id = str(item.get("customProjectId") or "").strip()
        if (
            not project_id
            or not item.get("delivered")
            or str(row_owner or item.get("ownerId") or "") != owner
            or str(item.get("byMemberId") or "") != owner
        ):
            continue
        counts[project_id] = counts.get(project_id, 0) + 1
    return counts


def count_custom_project_deliveries(project_id, owner_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            return _published_custom_delivery_counts_locked(
                conn,
                owner_id,
            ).get(str(project_id or "").strip(), 0)
        finally:
            conn.close()


def _custom_project_source_ids(item):
    """返回可用于幂等创建的非空子应用来源 ID。

    早期无限画布使用 sourceProjectId，视频工坊映射使用
    workshopProjectId；二者都只表示子应用中的原项目，不是权限凭据。
    """
    if not isinstance(item, dict):
        return set()
    state = item.get("projectState")
    if not isinstance(state, dict):
        return set()
    return {
        str(state.get(key) or "").strip()
        for key in ("sourceProjectId", "workshopProjectId")
        if str(state.get(key) or "").strip()
    }


def _find_custom_project_by_source_locked(conn, owner_id, kind, source_ids):
    """在调用方持有写事务时查找同 owner/kind/source 的已有项目。"""
    wanted = {str(value or "").strip() for value in source_ids if str(value or "").strip()}
    if not wanted:
        return None
    rows = conn.execute(
        """
        SELECT data
        FROM docs
        WHERE collection='customProjects' AND owner_id=?
        ORDER BY updated_at DESC
        """,
        (str(owner_id),),
    ).fetchall()
    for (raw,) in rows:
        try:
            item = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if str(item.get("kind") or "").strip().lower() != kind:
            continue
        if wanted.intersection(_custom_project_source_ids(item)):
            return item
    return None


def list_custom_projects(owner_id, kind=""):
    """列出当前成员自己的定制创作项目；草稿不会进入普通资产集合。"""
    _ensure_db()
    requested_kind = str(kind or "").strip().lower()
    if requested_kind and requested_kind not in CUSTOM_PROJECT_KINDS:
        raise ValueError("invalid_custom_project_kind")
    with _lock:
        conn = _connect()
        try:
            published_counts = _published_custom_delivery_counts_locked(
                conn,
                owner_id,
            )
            rows = conn.execute(
                "SELECT data FROM docs WHERE collection='customProjects' AND owner_id=? ORDER BY updated_at DESC",
                (str(owner_id),),
            ).fetchall()
            items = []
            for (raw,) in rows:
                try:
                    item = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if requested_kind and item.get("kind") != requested_kind:
                    continue
                item["publishedCount"] = published_counts.get(
                    str(item.get("id") or ""),
                    0,
                )
                items.append(item)
            return items
        finally:
            conn.close()


def custom_canvas_storage_namespace(owner_id):
    """返回由服务端当前登录成员决定的非敏感本地分仓名。

    该值只用于浏览器普通 UI 分桶，不是访问凭据；真正进入服务器的数据仍由
    customProjects/customOutputs 的 owner_id 校验保护。
    """
    digest = hashlib.sha256(f"xingzhen-canvas:{owner_id}".encode("utf-8")).hexdigest()[:24]
    return f"member-{digest}"


def _custom_canvas_source_id(value):
    source_id = str(value or "").strip()
    if (
        not source_id
        or len(source_id) > 180
        or any(ord(char) < 32 for char in source_id)
    ):
        raise ValueError("invalid_custom_canvas_source_id")
    return source_id


def _custom_canvas_json(value, *, limit, error):
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError, OverflowError):
        raise ValueError("invalid_custom_canvas_payload")
    if len(encoded.encode("utf-8")) > limit:
        raise ValueError(error)
    return encoded


def _custom_canvas_client_time(value, project, now):
    candidate = value
    if candidate in (None, "", 0, "0") and isinstance(project, dict):
        candidate = project.get("updatedAt")
    if candidate in (None, "", 0, "0"):
        return now
    try:
        parsed = int(float(candidate))
    except (TypeError, ValueError, OverflowError):
        raise ValueError("invalid_custom_canvas_client_time")
    if parsed < 0 or parsed > 9_999_999_999_999_999:
        raise ValueError("invalid_custom_canvas_client_time")
    return parsed


def _custom_canvas_validate_image_bytes(mime, data):
    if not data or len(data) > MAX_CUSTOM_CANVAS_BLOB_BYTES:
        raise ValueError("custom_canvas_blob_too_large")
    if mime == "image/png" and not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("invalid_custom_canvas_image")
    if mime == "image/jpeg" and not data.startswith(b"\xff\xd8\xff"):
        raise ValueError("invalid_custom_canvas_image")
    if mime == "image/webp" and not (len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP"):
        raise ValueError("invalid_custom_canvas_image")
    if mime == "image/gif" and not data.startswith((b"GIF87a", b"GIF89a")):
        raise ValueError("invalid_custom_canvas_image")
    if mime == "image/svg+xml":
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise ValueError("invalid_custom_canvas_image")
        lowered = text.lower()
        if "<svg" not in lowered:
            raise ValueError("invalid_custom_canvas_image")
        if (
            "<script" in lowered
            or "javascript:" in lowered
            or "<foreignobject" in lowered
            or re.search(r"\son[a-z0-9_-]+\s*=", lowered)
        ):
            raise ValueError("unsafe_custom_canvas_svg")


def _custom_canvas_parse_data_image(value):
    if not isinstance(value, str) or not value.lower().startswith("data:image/"):
        return None
    if "," not in value:
        raise ValueError("invalid_custom_canvas_image")
    header, payload = value[5:].split(",", 1)
    parts = [part.strip() for part in header.split(";")]
    mime = (parts[0] or "").lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    if mime not in CUSTOM_CANVAS_IMAGE_MIMES:
        raise ValueError("unsupported_custom_canvas_image_type")
    parameters = [part.lower() for part in parts[1:] if part]
    for parameter in parameters:
        if parameter == "base64" or parameter == "utf8" or parameter.startswith("charset="):
            continue
        raise ValueError("unsupported_custom_canvas_image_type")
    if len(payload) > MAX_CUSTOM_CANVAS_BLOB_BYTES * 4:
        raise ValueError("custom_canvas_blob_too_large")
    try:
        if "base64" in parameters:
            compact = re.sub(r"\s+", "", payload)
            data = base64.b64decode(compact, validate=True)
        else:
            if mime != "image/svg+xml":
                raise ValueError("invalid_custom_canvas_image")
            data = unquote_to_bytes(payload)
    except ValueError:
        raise
    except Exception:
        raise ValueError("invalid_custom_canvas_image")
    _custom_canvas_validate_image_bytes(mime, data)
    content_hash = hashlib.sha256(mime.encode("ascii") + b"\0" + data).hexdigest()
    return {
        "contentHash": content_hash,
        "mime": mime,
        "size": len(data),
        "data": data,
    }


def _custom_canvas_blob_url(content_hash):
    digest = str(content_hash or "")
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("invalid_custom_canvas_blob_ref")
    return f"/api/custom-canvas/blobs/{digest}"


def _custom_canvas_parse_blob_url(value):
    """Recognize only the same-origin URL shape emitted by this service.

    Ownership is deliberately validated later inside the database transaction;
    accepting an arbitrary absolute URL here could turn another member's hash
    into a stored reference.
    """
    if not isinstance(value, str):
        return None
    matched = re.fullmatch(
        r"/api/custom-canvas/blobs/([a-f0-9]{64})",
        value.strip(),
    )
    if not matched:
        return None
    return {
        "$type": CUSTOM_CANVAS_BLOB_REF_TYPE,
        "contentHash": matched.group(1),
    }


def _custom_canvas_replace_data_images(value, blob_specs, stats, depth=0):
    if depth > 48:
        raise ValueError("custom_canvas_payload_too_deep")
    stats["nodes"] += 1
    if stats["nodes"] > 120_000:
        raise ValueError("custom_canvas_payload_too_large")
    if isinstance(value, str):
        stable_ref = _custom_canvas_parse_blob_url(value)
        if stable_ref:
            return stable_ref
        parsed = _custom_canvas_parse_data_image(value)
        if parsed:
            digest = parsed["contentHash"]
            if digest not in blob_specs:
                if len(blob_specs) >= MAX_CUSTOM_CANVAS_BLOBS:
                    raise ValueError("custom_canvas_too_many_blobs")
                stats["blobBytes"] += parsed["size"]
                if stats["blobBytes"] > MAX_CUSTOM_CANVAS_TOTAL_BLOB_BYTES:
                    raise ValueError("custom_canvas_total_blob_too_large")
                blob_specs[digest] = parsed
            return {
                "$type": CUSTOM_CANVAS_BLOB_REF_TYPE,
                "contentHash": digest,
                "mime": parsed["mime"],
            }
        if re.match(r"^data:[a-z0-9.+-]+/", value, flags=re.I):
            raise ValueError("unsupported_custom_canvas_data_url")
        return value
    if isinstance(value, list):
        return [
            _custom_canvas_replace_data_images(item, blob_specs, stats, depth + 1)
            for item in value
        ]
    if isinstance(value, dict):
        return {
            str(key): _custom_canvas_replace_data_images(item, blob_specs, stats, depth + 1)
            for key, item in value.items()
        }
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise ValueError("invalid_custom_canvas_payload")


def _custom_canvas_blob_relative_path(owner_id, content_hash, mime):
    owner_scope = hashlib.sha256(
        f"canvas-blob:{owner_id}".encode("utf-8")
    ).hexdigest()[:24]
    extension = CUSTOM_CANVAS_IMAGE_MIMES.get(mime)
    if not extension or not re.fullmatch(r"[a-f0-9]{64}", str(content_hash or "")):
        raise ValueError("invalid_custom_canvas_blob_ref")
    return f"{owner_scope}/{content_hash}{extension}"


def _custom_canvas_blob_path(stored_name):
    root = CUSTOM_CANVAS_BLOB_DIR.expanduser().resolve()
    path = (root / str(stored_name or "")).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise ValueError("invalid_custom_canvas_blob_ref")
    return path


def _persist_custom_canvas_blobs_locked(
    conn,
    owner_id,
    blob_specs,
    now,
    created_files=None,
):
    """Persist this request's decoded images and track new filesystem writes.

    SQLite cannot roll back files written with ``os.replace``.  The caller
    therefore owns ``created_files`` and cleans those paths after a failed
    transaction.  Only paths that did not exist before this attempt are
    recorded; repairing an existing database row or reusing a pre-existing
    orphan must never make that file eligible for rollback deletion.
    """
    owner = str(owner_id)
    rollback_files = created_files if created_files is not None else []
    new_bytes = 0
    for content_hash, spec in blob_specs.items():
        if not conn.execute(
            "SELECT 1 FROM custom_canvas_blobs WHERE owner_id=? AND content_hash=?",
            (owner, content_hash),
        ).fetchone():
            new_bytes += int(spec["size"])
    current_bytes = int(conn.execute(
        "SELECT COALESCE(SUM(size),0) FROM custom_canvas_blobs WHERE owner_id=?",
        (owner,),
    ).fetchone()[0] or 0)
    if current_bytes + new_bytes > MAX_CUSTOM_CANVAS_OWNER_BLOB_BYTES:
        raise ValueError("custom_canvas_owner_blob_quota")
    for content_hash, spec in blob_specs.items():
        stored_name = _custom_canvas_blob_relative_path(
            owner_id,
            content_hash,
            spec["mime"],
        )
        row = conn.execute(
            "SELECT mime,size,stored_name FROM custom_canvas_blobs WHERE owner_id=? AND content_hash=?",
            (owner, content_hash),
        ).fetchone()
        if row and (
            str(row[0]) != spec["mime"]
            or int(row[1]) != int(spec["size"])
            or str(row[2]) != stored_name
        ):
            raise ValueError("custom_canvas_blob_conflict")
        path = _custom_canvas_blob_path(stored_name)
        path_existed = path.exists()
        if not path_existed:
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_bytes(spec["data"])
                os.chmod(temporary, 0o600)
                os.replace(temporary, path)
                if not row:
                    # Append immediately after the atomic filesystem write so
                    # even a later INSERT failure can be cleaned by the caller.
                    rollback_files.append((str(content_hash), stored_name))
            finally:
                if temporary.exists():
                    temporary.unlink()
        if not row:
            conn.execute(
                """
                INSERT INTO custom_canvas_blobs(
                  owner_id,content_hash,mime,size,stored_name,created_at
                ) VALUES(?,?,?,?,?,?)
                """,
                (
                    owner,
                    content_hash,
                    spec["mime"],
                    int(spec["size"]),
                    stored_name,
                    now,
                ),
            )


def _custom_canvas_collect_blob_hashes(value, output):
    if isinstance(value, list):
        for item in value:
            _custom_canvas_collect_blob_hashes(item, output)
    elif isinstance(value, dict):
        if value.get("$type") == CUSTOM_CANVAS_BLOB_REF_TYPE:
            digest = str(value.get("contentHash") or "")
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("invalid_custom_canvas_blob_ref")
            output.add(digest)
        else:
            for item in value.values():
                _custom_canvas_collect_blob_hashes(item, output)


def _custom_canvas_materialize_blob_refs(value, blob_urls):
    if isinstance(value, list):
        return [
            _custom_canvas_materialize_blob_refs(item, blob_urls)
            for item in value
        ]
    if isinstance(value, dict):
        if value.get("$type") == CUSTOM_CANVAS_BLOB_REF_TYPE:
            digest = str(value.get("contentHash") or "")
            if digest not in blob_urls:
                raise ValueError("custom_canvas_blob_missing")
            return blob_urls[digest]
        return {
            key: _custom_canvas_materialize_blob_refs(item, blob_urls)
            for key, item in value.items()
        }
    return value


def _custom_canvas_validate_blob_refs_locked(
    conn,
    owner_id,
    *payloads,
    pending_hashes=None,
):
    hashes = set()
    for payload in payloads:
        _custom_canvas_collect_blob_hashes(payload, hashes)
    if not hashes:
        return
    pending = {
        str(content_hash)
        for content_hash in (pending_hashes or ())
        if re.fullmatch(r"[a-f0-9]{64}", str(content_hash))
    }
    rows = conn.execute(
        """
        SELECT content_hash
        FROM custom_canvas_blobs
        WHERE owner_id=? AND content_hash IN (%s)
        """ % ",".join("?" for _ in hashes),
        (str(owner_id), *sorted(hashes)),
    ).fetchall()
    owned = {str(row[0]) for row in rows}
    if owned | pending != hashes:
        raise ValueError("invalid_custom_canvas_blob_ref")


def _custom_canvas_cleanup_rolled_back_blobs_locked(
    conn,
    owner_id,
    created_files,
):
    """Best-effort cleanup for files created by a rolled-back transaction.

    A path is unlinked only when this exact request created it and no committed
    owner/hash row exists after rollback.  This deliberately preserves files
    that existed before the request, including recoverable orphan files.
    """
    owner = str(owner_id)
    root = CUSTOM_CANVAS_BLOB_DIR.expanduser().resolve()
    for content_hash, stored_name in created_files:
        try:
            committed = conn.execute(
                """
                SELECT 1
                FROM custom_canvas_blobs
                WHERE owner_id=? AND content_hash=?
                """,
                (owner, str(content_hash)),
            ).fetchone()
            if committed:
                continue
            path = _custom_canvas_blob_path(stored_name)
            path.unlink(missing_ok=True)
            if path.parent != root:
                try:
                    path.parent.rmdir()
                except OSError:
                    pass
        except (OSError, ValueError, sqlite3.Error):
            # A leaked unreferenced file is safer than masking the original
            # save failure or risking deletion outside the private blob root.
            pass


def _custom_canvas_materialize_payloads_locked(conn, owner_id, *payloads):
    hashes = set()
    for payload in payloads:
        _custom_canvas_collect_blob_hashes(payload, hashes)
    blob_urls = {}
    if hashes:
        rows = conn.execute(
            """
            SELECT content_hash,mime,size,stored_name
            FROM custom_canvas_blobs
            WHERE owner_id=? AND content_hash IN (%s)
            """ % ",".join("?" for _ in hashes),
            (str(owner_id), *sorted(hashes)),
        ).fetchall()
        for content_hash, mime, size, stored_name in rows:
            path = _custom_canvas_blob_path(stored_name)
            if not path.is_file():
                raise ValueError("custom_canvas_blob_missing")
            if path.stat().st_size != int(size):
                raise ValueError("custom_canvas_blob_missing")
            if str(mime) not in CUSTOM_CANVAS_IMAGE_MIMES:
                raise ValueError("invalid_custom_canvas_blob_ref")
            blob_urls[str(content_hash)] = _custom_canvas_blob_url(content_hash)
        if set(blob_urls) != hashes:
            raise ValueError("custom_canvas_blob_missing")
    return [
        _custom_canvas_materialize_blob_refs(payload, blob_urls)
        for payload in payloads
    ]


def _custom_canvas_gc_blobs_locked(conn, owner_id):
    """Delete only this owner's blob rows no longer used by a live draft.

    The caller commits the database transaction before unlinking the returned
    files. This makes a failed transaction harmless; a failed unlink merely
    leaves an unreferenced file that a later maintenance pass can remove.
    """
    owner = str(owner_id)
    referenced = set()
    rows = conn.execute(
        """
        SELECT project_json,draft_json
        FROM custom_canvas_drafts
        WHERE owner_id=? AND deleted_at IS NULL
        """,
        (owner,),
    ).fetchall()
    for project_json, draft_json in rows:
        try:
            project = json.loads(project_json)
            draft = json.loads(draft_json)
        except (TypeError, json.JSONDecodeError):
            # Corrupt live state must block GC, otherwise its still-needed
            # images could be removed before an administrator can recover it.
            raise ValueError("invalid_custom_canvas_stored_state")
        _custom_canvas_collect_blob_hashes(project, referenced)
        _custom_canvas_collect_blob_hashes(draft, referenced)

    blob_rows = conn.execute(
        "SELECT content_hash,stored_name FROM custom_canvas_blobs WHERE owner_id=?",
        (owner,),
    ).fetchall()
    orphaned = [
        (str(content_hash), str(stored_name))
        for content_hash, stored_name in blob_rows
        if str(content_hash) not in referenced
    ]
    if orphaned:
        conn.executemany(
            "DELETE FROM custom_canvas_blobs WHERE owner_id=? AND content_hash=?",
            [(owner, content_hash) for content_hash, _ in orphaned],
        )
    return [stored_name for _, stored_name in orphaned]


def _custom_canvas_unlink_orphans(stored_names):
    for stored_name in stored_names:
        try:
            path = _custom_canvas_blob_path(stored_name)
            path.unlink(missing_ok=True)
            parent = path.parent
            if parent != CUSTOM_CANVAS_BLOB_DIR.expanduser().resolve():
                try:
                    parent.rmdir()
                except OSError:
                    pass
        except (OSError, ValueError):
            # Database state remains authoritative; an orphan file is safer
            # than failing or rolling back a successful user save.
            pass


def get_custom_canvas_blob(owner_id, content_hash):
    digest = str(content_hash or "")
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        return None, "not_found"
    _ensure_db()
    owner = str(owner_id or "")
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                """
                SELECT mime,size,stored_name
                FROM custom_canvas_blobs
                WHERE owner_id=? AND content_hash=?
                """,
                (owner, digest),
            ).fetchone()
            if not row:
                return None, "not_found"
            mime, size, stored_name = str(row[0]), int(row[1]), str(row[2])
            path = _custom_canvas_blob_path(stored_name)
            if mime not in CUSTOM_CANVAS_IMAGE_MIMES or not path.is_file():
                return None, "not_found"
            if path.stat().st_size != size:
                return None, "not_found"
            return {"path": path, "mime": mime, "size": size}, None
        finally:
            conn.close()


def _custom_canvas_draft_row_locked(conn, owner_id, source_project_id):
    row = conn.execute(
        """
        SELECT custom_project_id,revision,client_updated_at,server_updated_at,
               content_hash,project_json,draft_json,deleted_at
        FROM custom_canvas_drafts
        WHERE owner_id=? AND source_project_id=?
        """,
        (str(owner_id), str(source_project_id)),
    ).fetchone()
    if not row:
        return None
    try:
        project = json.loads(row[5])
        draft = json.loads(row[6])
    except (TypeError, json.JSONDecodeError):
        raise ValueError("invalid_custom_canvas_stored_state")
    if not isinstance(project, dict) or not isinstance(draft, dict):
        raise ValueError("invalid_custom_canvas_stored_state")
    return {
        "ownerId": str(owner_id),
        "sourceProjectId": str(source_project_id),
        "customProjectId": str(row[0] or ""),
        "revision": int(row[1] or 0),
        "clientUpdatedAt": int(row[2] or 0),
        "serverUpdatedAt": int(row[3] or 0),
        "contentHash": str(row[4] or ""),
        "project": project,
        "draft": draft,
        "deletedAt": int(row[7] or 0),
    }


def _custom_canvas_project_id(owner_id, source_project_id):
    owner_hash = hashlib.sha256(str(owner_id).encode("utf-8")).hexdigest()[:16]
    source_hash = hashlib.sha256(str(source_project_id).encode("utf-8")).hexdigest()[:24]
    return f"canvas-{owner_hash}-{source_hash}"


def _custom_canvas_sanitized_project(project, source_project_id, client_updated_at):
    clean = dict(project if isinstance(project, dict) else {})
    for key in (
        "ownerId", "customProjectId", "revision", "clientUpdatedAt",
        "serverUpdatedAt", "contentHash", "deletedAt", "status",
        "publishedDeliveryId", "publishedAt", "publishedItemIds",
        "publishedCount", "publishedVideoOutputs",
    ):
        clean.pop(key, None)
    clean["id"] = str(source_project_id)
    clean["updatedAt"] = int(client_updated_at)
    if "name" in clean:
        clean["name"] = str(clean.get("name") or "").strip()[:160] or "未命名项目"
    return clean


def _prepare_custom_canvas_draft(source_project_id, payload):
    incoming = payload if isinstance(payload, dict) else {}
    project = incoming.get("project")
    items = incoming.get("items")
    messages = incoming.get("messages")
    viewport = incoming.get("viewport")
    if not isinstance(project, dict):
        raise ValueError("invalid_custom_canvas_project")
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise ValueError("invalid_custom_canvas_items")
    if not isinstance(messages, list) or any(not isinstance(item, dict) for item in messages):
        raise ValueError("invalid_custom_canvas_messages")
    if viewport is None:
        viewport = {}
    if not isinstance(viewport, dict):
        raise ValueError("invalid_custom_canvas_viewport")
    if len(items) > MAX_CUSTOM_CANVAS_ITEMS:
        raise ValueError("custom_canvas_too_many_items")
    if len(messages) > MAX_CUSTOM_CANVAS_MESSAGES:
        raise ValueError("custom_canvas_too_many_messages")

    now = int(time.time() * 1000)
    client_updated_at = _custom_canvas_client_time(
        incoming.get("clientUpdatedAt"),
        project,
        now,
    )
    sanitized_project = _custom_canvas_sanitized_project(
        project,
        source_project_id,
        client_updated_at,
    )
    blob_specs = {}
    stats = {"nodes": 0, "blobBytes": 0}
    transformed = _custom_canvas_replace_data_images(
        {
            "project": sanitized_project,
            "draft": {
                "items": items,
                "messages": messages,
                "viewport": viewport,
            },
        },
        blob_specs,
        stats,
    )
    project_json = _custom_canvas_json(
        transformed["project"],
        limit=MAX_CUSTOM_CANVAS_PROJECT_BYTES,
        error="custom_canvas_project_too_large",
    )
    draft_json = _custom_canvas_json(
        transformed["draft"],
        limit=MAX_CUSTOM_CANVAS_DRAFT_BYTES,
        error="custom_canvas_draft_too_large",
    )
    content_hash = hashlib.sha256(
        (project_json + "\n" + draft_json).encode("utf-8")
    ).hexdigest()
    base_revision = incoming.get("baseRevision")
    if base_revision is not None:
        try:
            base_revision = int(base_revision)
        except (TypeError, ValueError, OverflowError):
            raise ValueError("invalid_custom_canvas_revision")
        if base_revision < 0:
            raise ValueError("invalid_custom_canvas_revision")
    return {
        "project": transformed["project"],
        "draft": transformed["draft"],
        "projectJson": project_json,
        "draftJson": draft_json,
        "contentHash": content_hash,
        "clientUpdatedAt": client_updated_at,
        "baseRevision": base_revision,
        "migration": bool(incoming.get("migration")),
        "blobSpecs": blob_specs,
        "now": now,
    }


def _ensure_custom_canvas_project_locked(
    conn,
    owner_id,
    source_project_id,
    project,
    revision,
    now,
    preferred_id="",
):
    owner = str(owner_id)
    matched = _find_custom_project_by_source_locked(
        conn,
        owner,
        "canvas",
        {source_project_id},
    )
    custom_project_id = str(
        (matched or {}).get("id")
        or preferred_id
        or _custom_canvas_project_id(owner, source_project_id)
    )
    existing_row = _custom_project_row(custom_project_id, conn)
    existing = dict(matched or {})
    if existing_row:
        stored_owner, stored_item = existing_row
        if stored_owner != owner:
            return None, "not_found"
        existing = dict(stored_item)
    elif conn.execute(
        "SELECT 1 FROM deleted_docs WHERE collection='customProjects' AND id=?",
        (custom_project_id,),
    ).fetchone():
        return None, "deleted"

    state = (
        dict(existing.get("projectState"))
        if isinstance(existing.get("projectState"), dict)
        else {}
    )
    state.update({
        "integration": "infinite-canvas",
        "sourceProjectId": str(source_project_id),
        "draftRevision": int(revision),
        "draftUpdatedAt": int(now),
    })
    title = str(
        project.get("name")
        or project.get("title")
        or existing.get("title")
        or "未命名画布项目"
    ).strip()[:120] or "未命名画布项目"
    item = {
        **existing,
        "id": custom_project_id,
        "ownerId": owner,
        "kind": "canvas",
        "title": title,
        "appVersion": str(
            project.get("appVersion")
            or existing.get("appVersion")
            or "infinite-canvas-server-draft-v1"
        ).strip()[:80],
        "projectState": state,
        "outputIds": list(existing.get("outputIds") or [])[:200],
        "thumbnailId": str(existing.get("thumbnailId") or "")[:160],
        "status": str(existing.get("status") or "draft"),
        "publishedDeliveryId": str(existing.get("publishedDeliveryId") or "")[:160],
        "createdAt": int(existing.get("createdAt") or project.get("createdAt") or now),
        "updatedAt": int(now),
    }
    conn.execute(
        """
        INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data)
        VALUES('customProjects',?,?,?,?)
        """,
        (
            custom_project_id,
            owner,
            int(now),
            json.dumps(item, ensure_ascii=False),
        ),
    )
    return item, None


def _custom_canvas_project_response_locked(conn, owner_id, row, published_counts=None):
    project = dict(row["project"])
    custom_row = _custom_project_row(row["customProjectId"], conn)
    custom_project = None
    if custom_row and custom_row[0] == str(owner_id):
        custom_project = custom_row[1]
    if published_counts is None:
        published_counts = _published_custom_delivery_counts_locked(conn, owner_id)
    project.update({
        "id": row["sourceProjectId"],
        "sourceId": row["sourceProjectId"],
        "sourceProjectId": row["sourceProjectId"],
        "customProjectId": row["customProjectId"],
        "revision": row["revision"],
        "clientUpdatedAt": row["clientUpdatedAt"],
        "serverUpdatedAt": row["serverUpdatedAt"],
        "contentHash": row["contentHash"],
        "publishedCount": published_counts.get(row["customProjectId"], 0),
    })
    if custom_project:
        custom_state = (
            custom_project.get("projectState")
            if isinstance(custom_project.get("projectState"), dict)
            else {}
        )
        project["status"] = str(custom_project.get("status") or "draft")
        delivery_id = str(custom_project.get("publishedDeliveryId") or "")
        if delivery_id:
            project["publishedDeliveryId"] = delivery_id
        if custom_project.get("publishedAt"):
            project["publishedAt"] = int(custom_project.get("publishedAt") or 0)
        published_item_ids = [
            str(value)[:180]
            for value in (custom_state.get("publishedItemIds") or [])[:200]
            if str(value or "").strip()
        ]
        if published_item_ids:
            project["publishedItemIds"] = published_item_ids
    return project


def _custom_canvas_thumbnail_url(value):
    if isinstance(value, str) and re.match(r"^(?:https?:|/)", value):
        return value[:2048]
    if isinstance(value, dict) and value.get("$type") == CUSTOM_CANVAS_BLOB_REF_TYPE:
        content_hash = str(value.get("contentHash") or "")
        if re.fullmatch(r"[a-f0-9]{64}", content_hash):
            return _custom_canvas_blob_url(content_hash)
    return ""


def _custom_canvas_draft_thumbnail(project, draft):
    items = list((draft or {}).get("items") or []) if isinstance(draft, dict) else []

    def usable(item):
        if not isinstance(item, dict) or item.get("type") not in {
            "reference", "generation", "enhanced",
        }:
            return ""
        if item.get("loading"):
            return ""
        return _custom_canvas_thumbnail_url(item.get("assetUrl"))

    visible = [item for item in items if isinstance(item, dict) and not item.get("hidden")]
    groups = (
        [item for item in visible if item.get("type") in {"generation", "enhanced"}],
        visible,
        [item for item in items if isinstance(item, dict)
         and item.get("type") == "reference" and item.get("hidden")],
        items,
    )
    for group in groups:
        for item in group:
            thumbnail = usable(item)
            if thumbnail:
                return thumbnail
    return _custom_canvas_thumbnail_url((project or {}).get("thumbnailUrl"))


def _custom_canvas_light_project_summary(project, draft=None):
    """列表只返回首页所需字段，不读取或暴露完整图片 Blob。"""
    source = project if isinstance(project, dict) else {}
    summary = {
        key: source.get(key)
        for key in (
            "id", "name", "title", "scene", "targetSize", "createdAt",
            "updatedAt", "cost", "generations", "failures", "appVersion",
        )
        if source.get(key) is not None
    }
    thumbnail = _custom_canvas_draft_thumbnail(source, draft)
    if thumbnail:
        summary["thumbnailUrl"] = thumbnail
    return summary


def _custom_canvas_payload_locked(conn, owner_id, row, published_counts=None):
    project, draft = _custom_canvas_materialize_payloads_locked(
        conn,
        owner_id,
        row["project"],
        row["draft"],
    )
    materialized = dict(row)
    materialized["project"] = project
    materialized["draft"] = draft
    project_response = _custom_canvas_project_response_locked(
        conn,
        owner_id,
        materialized,
        published_counts,
    )
    thumbnail = _custom_canvas_draft_thumbnail(project, draft)
    if thumbnail:
        project_response["thumbnailUrl"] = thumbnail
    else:
        project_response.pop("thumbnailUrl", None)
    return {
        "project": project_response,
        "state": {
            "items": list(draft.get("items") or []),
            "messages": list(draft.get("messages") or []),
            "viewport": dict(draft.get("viewport") or {}),
        },
    }


def list_custom_canvas_drafts(owner_id):
    _ensure_db()
    owner = str(owner_id or "")
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                """
                SELECT source_project_id
                FROM custom_canvas_drafts
                WHERE owner_id=?
                ORDER BY server_updated_at DESC, source_project_id
                """,
                (owner,),
            ).fetchall()
            published_counts = _published_custom_delivery_counts_locked(conn, owner)
            items = []
            tombstones = []
            for (source_project_id,) in rows:
                row = _custom_canvas_draft_row_locked(conn, owner, source_project_id)
                if not row:
                    continue
                if row["deletedAt"]:
                    tombstones.append({
                        "sourceId": row["sourceProjectId"],
                        "sourceProjectId": row["sourceProjectId"],
                        "revision": row["revision"],
                        "clientUpdatedAt": row["clientUpdatedAt"],
                        "deletedAt": row["deletedAt"],
                    })
                    continue
                display_row = dict(row)
                display_row["project"] = _custom_canvas_light_project_summary(
                    row["project"],
                    row["draft"],
                )
                items.append(_custom_canvas_project_response_locked(
                    conn,
                    owner,
                    display_row,
                    published_counts,
                ))
            return items, tombstones
        finally:
            conn.close()


def get_custom_canvas_draft(owner_id, source_project_id):
    source_id = _custom_canvas_source_id(source_project_id)
    _ensure_db()
    owner = str(owner_id or "")
    with _lock:
        conn = _connect()
        try:
            row = _custom_canvas_draft_row_locked(conn, owner, source_id)
            if not row:
                return None, "not_found"
            if row["deletedAt"]:
                return None, "deleted"
            return _custom_canvas_payload_locked(conn, owner, row), None
        finally:
            conn.close()


def save_custom_canvas_draft(owner_id, source_project_id, payload):
    source_id = _custom_canvas_source_id(source_project_id)
    prepared = _prepare_custom_canvas_draft(source_id, payload)
    _ensure_db()
    owner = str(owner_id or "")
    with _lock:
        conn = _connect()
        created_blob_files = []
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing = _custom_canvas_draft_row_locked(conn, owner, source_id)
            if existing and existing["deletedAt"]:
                conn.rollback()
                return None, "deleted", "deleted"
            if existing and existing["contentHash"] == prepared["contentHash"]:
                result = _custom_canvas_payload_locked(conn, owner, existing)
                conn.rollback()
                return result, None, "unchanged"
            if existing:
                old_items = existing["draft"].get("items")
                old_messages = existing["draft"].get("messages")
                new_items = prepared["draft"].get("items")
                new_messages = prepared["draft"].get("messages")
                migration_fill = False
                if prepared["migration"]:
                    # A previously-created server shell must not hide a richer
                    # verified legacy canvas forever.  This is the only
                    # migration overwrite allowed: once the server contains a
                    # node or message it remains authoritative.
                    server_has_content = bool(old_items) or bool(old_messages)
                    migration_has_content = bool(new_items) or bool(new_messages)
                    if server_has_content or not migration_has_content:
                        result = _custom_canvas_payload_locked(conn, owner, existing)
                        conn.rollback()
                        return result, None, "server-newer"
                    migration_fill = True
                if not migration_fill:
                    if (
                        prepared["baseRevision"] is None
                        or prepared["baseRevision"] != existing["revision"]
                    ):
                        conn.rollback()
                        return None, "conflict", "conflict"
                    # 相同时间戳但内容不同也不能猜测覆盖顺序；同内容已在上方幂等返回。
                    if prepared["clientUpdatedAt"] <= existing["clientUpdatedAt"]:
                        conn.rollback()
                        return None, "server_newer", "server-newer"
                    server_has_content = bool(old_items) or bool(old_messages)
                    incoming_has_content = bool(new_items) or bool(new_messages)
                    if server_has_content and not incoming_has_content:
                        conn.rollback()
                        return None, "empty_snapshot", "rejected"
                revision = existing["revision"] + 1
                custom_project_id = existing["customProjectId"]
            else:
                if prepared["baseRevision"] not in (None, 0):
                    conn.rollback()
                    return None, "conflict", "conflict"
                revision = 1
                custom_project_id = ""

            # Reject forged stable URLs before writing any new data URL blob.
            # Hashes decoded from this request are allowed as pending until the
            # transaction inserts their owner-scoped rows below.
            _custom_canvas_validate_blob_refs_locked(
                conn,
                owner,
                prepared["project"],
                prepared["draft"],
                pending_hashes=prepared["blobSpecs"],
            )
            _persist_custom_canvas_blobs_locked(
                conn,
                owner,
                prepared["blobSpecs"],
                prepared["now"],
                created_blob_files,
            )
            _custom_canvas_validate_blob_refs_locked(
                conn,
                owner,
                prepared["project"],
                prepared["draft"],
            )
            custom_project, project_error = _ensure_custom_canvas_project_locked(
                conn,
                owner,
                source_id,
                prepared["project"],
                revision,
                prepared["now"],
                custom_project_id,
            )
            if project_error:
                conn.rollback()
                _custom_canvas_cleanup_rolled_back_blobs_locked(
                    conn,
                    owner,
                    created_blob_files,
                )
                return None, project_error, "rejected"
            custom_project_id = custom_project["id"]
            conn.execute(
                """
                INSERT INTO custom_canvas_drafts(
                  owner_id,source_project_id,custom_project_id,revision,
                  client_updated_at,server_updated_at,content_hash,
                  project_json,draft_json,deleted_at
                ) VALUES(?,?,?,?,?,?,?,?,?,NULL)
                ON CONFLICT(owner_id,source_project_id) DO UPDATE SET
                  custom_project_id=excluded.custom_project_id,
                  revision=excluded.revision,
                  client_updated_at=excluded.client_updated_at,
                  server_updated_at=excluded.server_updated_at,
                  content_hash=excluded.content_hash,
                  project_json=excluded.project_json,
                  draft_json=excluded.draft_json,
                  deleted_at=NULL
                """,
                (
                    owner,
                    source_id,
                    custom_project_id,
                    revision,
                    prepared["clientUpdatedAt"],
                    prepared["now"],
                    prepared["contentHash"],
                    prepared["projectJson"],
                    prepared["draftJson"],
                ),
            )
            orphaned_files = _custom_canvas_gc_blobs_locked(conn, owner)
            stored = _custom_canvas_draft_row_locked(conn, owner, source_id)
            result = _custom_canvas_payload_locked(conn, owner, stored)
            conn.commit()
            _custom_canvas_unlink_orphans(orphaned_files)
            return result, None, "created" if not existing else "updated"
        except Exception:
            conn.rollback()
            _custom_canvas_cleanup_rolled_back_blobs_locked(
                conn,
                owner,
                created_blob_files,
            )
            raise
        finally:
            conn.close()


def delete_custom_canvas_draft(owner_id, source_project_id):
    source_id = _custom_canvas_source_id(source_project_id)
    _ensure_db()
    owner = str(owner_id or "")
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = _custom_canvas_draft_row_locked(conn, owner, source_id)
            if not row:
                # DELETE can race the first autosave from another browser/tab.
                # Persist a tombstone even when the PUT has not arrived yet so
                # the later request receives 410 instead of recreating the draft.
                now = int(time.time() * 1000)
                project = {"id": source_id, "updatedAt": now}
                draft = {"items": [], "messages": [], "viewport": {}}
                project_json = _custom_canvas_json(
                    project,
                    limit=MAX_CUSTOM_CANVAS_PROJECT_BYTES,
                    error="custom_canvas_project_too_large",
                )
                draft_json = _custom_canvas_json(
                    draft,
                    limit=MAX_CUSTOM_CANVAS_DRAFT_BYTES,
                    error="custom_canvas_draft_too_large",
                )
                content_hash = hashlib.sha256(
                    (project_json + "\n" + draft_json).encode("utf-8")
                ).hexdigest()
                conn.execute(
                    """
                    INSERT INTO custom_canvas_drafts(
                      owner_id,source_project_id,custom_project_id,revision,
                      client_updated_at,server_updated_at,content_hash,
                      project_json,draft_json,deleted_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        owner,
                        source_id,
                        _custom_canvas_project_id(owner, source_id),
                        1,
                        now,
                        now,
                        content_hash,
                        project_json,
                        draft_json,
                        now,
                    ),
                )
                orphaned_files = _custom_canvas_gc_blobs_locked(conn, owner)
                conn.commit()
                _custom_canvas_unlink_orphans(orphaned_files)
                return {
                    "sourceId": source_id,
                    "sourceProjectId": source_id,
                    "revision": 1,
                    "deletedAt": now,
                }, None
            if row["deletedAt"]:
                conn.rollback()
                return {
                    "sourceId": source_id,
                    "sourceProjectId": source_id,
                    "revision": row["revision"],
                    "deletedAt": row["deletedAt"],
                }, None
            now = int(time.time() * 1000)
            revision = row["revision"] + 1
            conn.execute(
                """
                UPDATE custom_canvas_drafts
                SET revision=?,server_updated_at=?,deleted_at=?
                WHERE owner_id=? AND source_project_id=?
                """,
                (revision, now, now, owner, source_id),
            )
            orphaned_files = _custom_canvas_gc_blobs_locked(conn, owner)
            conn.commit()
            _custom_canvas_unlink_orphans(orphaned_files)
            return {
                "sourceId": source_id,
                "sourceProjectId": source_id,
                "revision": revision,
                "deletedAt": now,
            }, None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def get_custom_project(project_id, owner_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = _custom_project_row(project_id, conn)
            if not row:
                return None, "not_found"
            stored_owner, item = row
            if stored_owner != str(owner_id):
                return None, "forbidden"
            item["publishedCount"] = _published_custom_delivery_counts_locked(
                conn,
                owner_id,
            ).get(str(project_id or ""), 0)
            return item, None
        finally:
            conn.close()


def save_custom_project(owner_id, payload, project_id=""):
    """由服务端写入 ownerId，并幂等创建有稳定子应用来源 ID 的项目。

    幂等范围仅限「创建请求 + 非空 sourceProjectId/workshopProjectId」。
    查询和插入处于同一个 BEGIN IMMEDIATE 事务中，避免两个标签页同时
    list→create 时生成重复项目；更新已有项目及没有来源 ID 的旧流程不变。
    """
    _ensure_db()
    incoming = payload if isinstance(payload, dict) else {}
    now = int(time.time() * 1000)
    pid = str(project_id or incoming.get("id") or uuid.uuid4().hex)
    is_create_request = not str(project_id or "").strip()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing_row = _custom_project_row(pid, conn)
            existing = {}
            if existing_row:
                stored_owner, existing = existing_row
                if stored_owner != str(owner_id):
                    return None, "forbidden"
            def incoming_or_existing(key, default=None):
                return incoming[key] if key in incoming else existing.get(key, default)

            kind = str(incoming_or_existing("kind", "video") or "video").strip().lower()
            if kind not in CUSTOM_PROJECT_KINDS:
                raise ValueError("invalid_custom_project_kind")
            status = str(incoming_or_existing("status", "draft") or "draft").strip().lower()
            if status not in CUSTOM_PROJECT_STATUSES:
                raise ValueError("invalid_custom_project_status")
            state = incoming.get("projectState") if "projectState" in incoming else existing.get("projectState")
            if not isinstance(state, dict):
                state = {}
            serialized_state = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
            if len(serialized_state.encode("utf-8")) > MAX_CUSTOM_PROJECT_STATE_BYTES:
                raise ValueError("custom_project_state_too_large")
            if "data:image/" in serialized_state or "data:video/" in serialized_state or "data:audio/" in serialized_state:
                raise ValueError("custom_project_binary_not_allowed")
            if is_create_request and not existing_row:
                matched = _find_custom_project_by_source_locked(
                    conn,
                    owner_id,
                    kind,
                    _custom_project_source_ids({"projectState": state}),
                )
                if matched:
                    conn.rollback()
                    return matched, None
            created_at = int(existing.get("createdAt") or incoming.get("createdAt") or now)
            item = {
                **existing,
                "id": pid,
                "ownerId": str(owner_id),
                "kind": kind,
                "title": str(incoming_or_existing("title", "未命名项目") or "").strip()[:120] or "未命名项目",
                "appVersion": str(incoming_or_existing("appVersion", "") or "").strip()[:80],
                "projectState": state,
                "outputIds": [
                    str(value) for value in (incoming_or_existing("outputIds", []) or [])
                    if value
                ][:200],
                "thumbnailId": str(incoming_or_existing("thumbnailId", "") or "").strip()[:160],
                "status": status,
                "publishedDeliveryId": str(incoming_or_existing("publishedDeliveryId", "") or "").strip()[:160],
                "createdAt": created_at,
                "updatedAt": now,
            }
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("customProjects", pid, str(owner_id), now, json.dumps(item, ensure_ascii=False)),
            )
            conn.execute(
                "DELETE FROM deleted_docs WHERE collection='customProjects' AND id=?",
                (pid,),
            )
            conn.commit()
            return item, None
        finally:
            conn.close()


def mark_custom_project_published(project_id, owner_id, delivery_id):
    """把 owner 自己的定制项目与已经同步成功的交付记录绑定。

    必须先在 assets 集合看到真实交付记录，且交付记录归当前成员、项目 ID
    与当前项目一致，避免只改一个状态就让空包或他人的交付单显示为已发布。
    """
    _ensure_db()
    pid = str(project_id or "").strip()
    did = str(delivery_id or "").strip()
    if not pid or not did:
        return None, "invalid_publish_request"
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            row = _custom_project_row(pid, conn)
            if not row:
                return None, "not_found"
            stored_owner, project = row
            if stored_owner != str(owner_id):
                return None, "forbidden"
            delivery_row = conn.execute(
                "SELECT data FROM docs WHERE collection='assets' AND id=?",
                (did,),
            ).fetchone()
            if not delivery_row:
                return None, "delivery_not_found"
            try:
                delivery = json.loads(delivery_row[0])
            except (TypeError, json.JSONDecodeError):
                return None, "delivery_not_found"
            if (
                not delivery.get("delivered")
                or str(delivery.get("customProjectId") or "") != pid
                or str(delivery.get("byMemberId") or "") != str(owner_id)
            ):
                return None, "delivery_mismatch"
            project["status"] = "published"
            project["publishedDeliveryId"] = did[:160]
            project["publishedAt"] = now
            project_state = (
                dict(project.get("projectState"))
                if isinstance(project.get("projectState"), dict)
                else {}
            )
            if str(project.get("kind") or "").strip().lower() == "canvas":
                project_state["publishedItemIds"] = sorted({
                    *[
                        str(value)[:180]
                        for value in (project_state.get("publishedItemIds") or [])[:200]
                        if str(value or "").strip()
                    ],
                    *[
                        str(value)[:180]
                        for value in (delivery.get("sourceItemIds") or [])[:20]
                        if str(value or "").strip()
                    ],
                })[:200]
                project["projectState"] = project_state
            project["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("customProjects", pid, str(owner_id), now, json.dumps(project, ensure_ascii=False)),
            )
            conn.commit()
            result = dict(project)
            result["publishedCount"] = _published_custom_delivery_counts_locked(
                conn,
                owner_id,
            ).get(pid, 0)
            return result, None
        finally:
            conn.close()


def _int_at_least_zero(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _custom_delivery_authoritative_name(account, export_seq, product_tag="", now_ms=0):
    """按服务器账号快照和已分配序号生成交付名，客户端旧序号不得参与。"""
    platform_code = {
        "小红书": "XHS",
        "视频号": "SPH",
        "抖音": "DY",
        "公众号": "GZH",
    }.get(str(account.get("platform") or "").strip(), "XHS")
    account_name = "".join(str(account.get("name") or "账号").split()) or "账号"
    if str(account.get("mode") or "").strip() == "视频":
        content_mode = str(account.get("subType") or "视频").strip() or "视频"
    else:
        content_mode = "图文"
    timestamp_ms = _int_at_least_zero(now_ms) or int(time.time() * 1000)
    # 交付业务日期固定按中国标准时间，避免容器默认 UTC 在午夜产生前一天包名。
    date_stamp = time.strftime(
        "%Y%m%d",
        time.gmtime(timestamp_ms / 1000 + 8 * 60 * 60),
    )
    name = (
        f"{platform_code}-{account_name}-{content_mode}-"
        f"{_int_at_least_zero(export_seq):03d}-{date_stamp}"
    )
    tag = " ".join(str(product_tag or "").strip().split())[:20]
    if tag and f"-{tag}-" not in name:
        prefix, date = name.rsplit("-", 1)
        name = f"{prefix}-{tag}-{date}"
    return name


def _custom_delivery_retract_error(delivery):
    status = str(delivery.get("status") or "").strip()
    if str(delivery.get("publishedUrl") or "").strip() or status == "已发布":
        return "delivery_already_published"
    if delivery.get("supplierDownloadedAt") or status == "已下载":
        return "delivery_already_downloaded"
    return None


def _custom_delivery_dependencies(kind, delivery):
    if kind == "video":
        source_id = str(delivery.get("sourceAssetId") or "").strip()
        cover_id = str(delivery.get("coverAssetId") or "").strip()
        if not source_id or not cover_id or not str(delivery.get("videoUrl") or "").strip():
            return None, None
        return [source_id, cover_id], {cover_id}
    pack_ids = []
    for value in (delivery.get("packAssetIds") or [])[:20]:
        asset_id = str(value or "").strip()
        if asset_id and asset_id not in pack_ids:
            pack_ids.append(asset_id)
    if not pack_ids:
        return None, None
    return pack_ids, set(pack_ids)


def _delivery_sequences_reconciled(conn):
    row = conn.execute("SELECT v FROM meta WHERE k='delivery_pub_seq_reconciled_v2'").fetchone()
    return str(row[0] if row else "") == "1"


def _delivery_sequence_time(item):
    """交付编号只按交付进入发布清单的时间排序，不以供应商回传时间重排。"""
    for value in (item.get("deliveredAt"), item.get("createdAt"), item.get("updatedAt")):
        numeric = _int_at_least_zero(value)
        if numeric:
            return numeric
    return 0


def _next_delivery_pub_seq(conn):
    """从服务端唯一账本预留下一条发布编号，供所有创作者共享。"""
    row = conn.execute("SELECT v FROM meta WHERE k='delivery_pub_seq'").fetchone()
    legacy_row = conn.execute("SELECT v FROM meta WHERE k='custom_delivery_pub_seq'").fetchone()
    current = max(
        _int_at_least_zero(row[0] if row else 0),
        _int_at_least_zero(legacy_row[0] if legacy_row else 0),
    )
    # 兼容已写入的历史资产；账本只能前进，不能因回撤而复用。
    for (raw,) in conn.execute(
        "SELECT data FROM docs WHERE collection='assets'"
    ).fetchall():
        try:
            item = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if item.get("delivered"):
            current = max(current, _int_at_least_zero(item.get("pubSeq")))
    value = current + 1
    conn.execute(
        "INSERT OR REPLACE INTO meta(k,v) VALUES('delivery_pub_seq',?)",
        (str(value),),
    )
    # 保留旧 key，避免仍在运行的旧定制交付流程倒退或重复领号。
    conn.execute(
        "INSERT OR REPLACE INTO meta(k,v) VALUES('custom_delivery_pub_seq',?)",
        (str(value),),
    )
    return value


def _next_custom_delivery_pub_seq(conn):
    """兼容旧调用名；定制创作与常规交付共用同一发布编号账本。"""
    return _next_delivery_pub_seq(conn)


def reconcile_delivery_sequences():
    """一次性把历史交付按真实交付时间校准为全局连续编号。

    这是受控迁移：仅修改 delivered 资产的 ``pubSeq`` 和用于并发保护的
    ``updatedAt``，不触碰账号、文件、素材、回传链接或供应商状态。迁移完成后
    写入版本标记，重复调用只返回结果而不会再次改写历史编号。
    """
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            if _delivery_sequences_reconciled(conn):
                total = 0
                for (raw,) in conn.execute("SELECT data FROM docs WHERE collection='assets'").fetchall():
                    try:
                        total += 1 if json.loads(raw).get("delivered") else 0
                    except (TypeError, json.JSONDecodeError):
                        continue
                return {"migrated": False, "updated": 0, "total": total}

            rows = conn.execute(
                "SELECT id,owner_id,data FROM docs WHERE collection='assets'"
            ).fetchall()
            delivered = []
            for doc_id, owner_id, raw in rows:
                try:
                    item = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if item.get("delivered"):
                    delivered.append((str(doc_id), owner_id, item))

            delivered.sort(key=lambda entry: (_delivery_sequence_time(entry[2]), entry[0]))
            now = int(time.time() * 1000)
            updated = 0
            for sequence, (doc_id, owner_id, item) in enumerate(delivered, start=1):
                if _int_at_least_zero(item.get("pubSeq")) == sequence:
                    continue
                item["pubSeq"] = sequence
                item.pop("projectedSeq", None)
                item["updatedAt"] = max(_int_at_least_zero(item.get("updatedAt")), now)
                conn.execute(
                    "UPDATE docs SET updated_at=?, data=? WHERE collection='assets' AND id=?",
                    (item["updatedAt"], json.dumps(item, ensure_ascii=False), doc_id),
                )
                updated += 1

            last_sequence = len(delivered)
            conn.execute(
                "INSERT OR REPLACE INTO meta(k,v) VALUES('delivery_pub_seq',?)",
                (str(last_sequence),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO meta(k,v) VALUES('custom_delivery_pub_seq',?)",
                (str(last_sequence),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO meta(k,v) VALUES('delivery_pub_seq_reconciled_v2','1')"
            )
            conn.commit()
            return {"migrated": True, "updated": updated, "total": last_sequence}
        finally:
            conn.close()


def _custom_publish_result(project, account, delivery):
    return {
        "project": dict(project),
        "account": dict(account),
        "delivery": dict(delivery),
    }


def publish_custom_project_bundle(project_id, owner_id, payload):
    """由服务器在一个写事务中分配序号、更新账号并写入完整定制交付。"""
    _ensure_db()
    incoming = payload if isinstance(payload, dict) else {}
    pid = str(project_id or "").strip()
    owner = str(owner_id or "")
    did = str(incoming.get("deliveryId") or "").strip()
    delivery_input = incoming.get("delivery") if isinstance(incoming.get("delivery"), dict) else {}
    account_input = incoming.get("account") if isinstance(incoming.get("account"), dict) else {}
    asset_items = [
        dict(item) for item in (incoming.get("assets") or [])
        if isinstance(item, dict) and item.get("id")
    ]
    if not pid or not did or str(delivery_input.get("id") or "") != did:
        return None, "invalid_publish_request"
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = _custom_project_row(pid, conn)
            if not row:
                return None, "not_found"
            stored_owner, project = row
            if stored_owner != owner:
                return None, "forbidden"

            account_id = str(delivery_input.get("accountId") or "").strip()
            if (
                not delivery_input.get("delivered")
                or str(delivery_input.get("customProjectId") or "") != pid
                or str(delivery_input.get("byMemberId") or "") != owner
                or (delivery_input.get("ownerId") and str(delivery_input.get("ownerId")) != owner)
                or not account_id
                or (account_input.get("id") and str(account_input.get("id")) != account_id)
            ):
                return None, "delivery_mismatch"

            account_deleted = conn.execute(
                "SELECT 1 FROM deleted_docs WHERE collection='accounts' AND id=?",
                (account_id,),
            ).fetchone()
            if account_deleted:
                return None, "account_deleted"
            account_row = conn.execute(
                "SELECT owner_id,data FROM docs WHERE collection='accounts' AND id=?",
                (account_id,),
            ).fetchone()
            if not account_row:
                return None, "account_not_found"
            try:
                account = json.loads(account_row[1])
            except (TypeError, json.JSONDecodeError):
                return None, "account_not_found"

            kind = str(project.get("kind") or "").strip().lower()
            delivery_type = str(delivery_input.get("type") or "")
            expected_mode = "视频" if kind == "video" else "图文"
            expected_type = "视频" if kind == "video" else "图集"
            if kind not in CUSTOM_PROJECT_KINDS or delivery_type != expected_type:
                return None, "delivery_mismatch"
            if str(account.get("mode") or "").strip() != expected_mode:
                return None, "account_mode_mismatch"

            # 同一 deliveryId 的网络重试直接返回服务器规范值，不再递增任何计数。
            if conn.execute(
                "SELECT 1 FROM deleted_docs WHERE collection='assets' AND id=?",
                (did,),
            ).fetchone():
                return None, "delivery_asset_deleted"
            existing_delivery_row = conn.execute(
                "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                (did,),
            ).fetchone()
            if existing_delivery_row:
                try:
                    existing_delivery = json.loads(existing_delivery_row[1])
                except (TypeError, json.JSONDecodeError):
                    return None, "delivery_mismatch"
                if (
                    existing_delivery_row[0] != owner
                    or not existing_delivery.get("delivered")
                    or str(existing_delivery.get("customProjectId") or "") != pid
                    or str(existing_delivery.get("byMemberId") or "") != owner
                    or str(existing_delivery.get("accountId") or "") != account_id
                ):
                    return None, "delivery_mismatch"
                conn.rollback()
                project_result = dict(project)
                project_result["publishedCount"] = _published_custom_delivery_counts_locked(
                    conn,
                    owner,
                ).get(pid, 0)
                return _custom_publish_result(project_result, account, existing_delivery), None

            dependency_ids, shared_dependency_ids = _custom_delivery_dependencies(kind, delivery_input)
            if not dependency_ids or did in dependency_ids:
                return None, "delivery_mismatch"
            by_id = {str(item.get("id")): item for item in asset_items}
            required_ids = set(dependency_ids)
            if not required_ids.issubset(by_id):
                return None, "delivery_asset_missing"
            tombstone_ids = sorted({did, *dependency_ids})
            deleted_asset_ids = {
                str(row[0]) for row in conn.execute(
                    "SELECT id FROM deleted_docs WHERE collection='assets' AND id IN (%s)"
                    % ",".join("?" for _ in tombstone_ids),
                    tuple(tombstone_ids),
                ).fetchall()
            }
            if deleted_asset_ids:
                return None, "delivery_asset_deleted"

            normalized_assets = {}
            for asset_id in dependency_ids:
                incoming_asset = by_id[asset_id]
                expected_asset_type = (
                    "视频"
                    if kind == "video" and asset_id == str(delivery_input.get("sourceAssetId") or "")
                    else "图片"
                )
                if (
                    incoming_asset.get("delivered")
                    or str(incoming_asset.get("accountId") or "") != account_id
                    or str(incoming_asset.get("type") or "") != expected_asset_type
                    or (
                        incoming_asset.get("ownerId")
                        and str(incoming_asset.get("ownerId")) != owner
                    )
                ):
                    return None, "delivery_asset_mismatch"
                existing_asset_row = conn.execute(
                    "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                    (asset_id,),
                ).fetchone()
                if existing_asset_row:
                    try:
                        asset = json.loads(existing_asset_row[1])
                    except (TypeError, json.JSONDecodeError):
                        return None, "delivery_asset_mismatch"
                    if (
                        existing_asset_row[0] != owner
                        or asset.get("delivered")
                        or str(asset.get("accountId") or "") != account_id
                        or str(asset.get("type") or "") != expected_asset_type
                    ):
                        return None, "delivery_asset_mismatch"
                else:
                    asset = dict(incoming_asset)
                    asset["createdAt"] = int(asset.get("createdAt") or now)
                    if asset_id not in shared_dependency_ids:
                        asset["shared"] = False
                        asset.pop("sharedAt", None)
                        asset.pop("sharedSource", None)
                asset["id"] = asset_id
                asset["ownerId"] = owner
                asset["accountId"] = account_id
                asset["delivered"] = False
                asset["updatedAt"] = now
                if asset_id in shared_dependency_ids:
                    refs = [
                        str(value) for value in (asset.get("customDeliveryShareRefs") or [])
                        if value and str(value) != did
                    ]
                    refs.append(did)
                    if "sharedBeforeCustomDelivery" not in asset:
                        client_delivery_share = str(asset.get("sharedSource") or "").startswith("delivered-custom")
                        asset["sharedBeforeCustomDelivery"] = bool(asset.get("shared")) and not client_delivery_share
                    asset["customDeliveryShareRefs"] = refs
                    asset["shared"] = True
                    asset["sharedAt"] = int(asset.get("sharedAt") or now)
                    asset["sharedSource"] = "custom-delivery"
                normalized_assets[asset_id] = asset

            pub_seq = _next_custom_delivery_pub_seq(conn)
            account["monthlyDone"] = _int_at_least_zero(account.get("monthlyDone")) + 1
            account["exportSeq"] = _int_at_least_zero(account.get("exportSeq")) + 1
            account["updatedAt"] = now
            product_tag = (
                " ".join(str(delivery_input.get("productTag") or "").strip().split())[:20]
                or "定制创作"
            )
            delivery_name = _custom_delivery_authoritative_name(
                account,
                account["exportSeq"],
                product_tag,
                now,
            )

            delivery = dict(delivery_input)
            for key in (
                "publishedUrl", "supplierNote", "publishedTitle", "publishedRawText",
                "publishedAt", "publishedUpdatedAt", "publishedUpdatedBy",
                "supplierDownloadedAt", "supplierDownloadedBy",
                "remarks", "remarkReadAt", "latestRemarkAt",
                "viewsUpdatedAt", "viewsUpdatedBy", "viewCount",
            ):
                delivery.pop(key, None)
            delivery.update({
                "id": did,
                "ownerId": owner,
                "accountId": account_id,
                "customProjectId": pid,
                "customOutputKind": kind,
                "byMemberId": owner,
                "type": expected_type,
                "delivered": True,
                "status": "未下载",
                "pubSeq": pub_seq,
                "exportSeq": account["exportSeq"],
                "name": delivery_name,
                "byAccount": str(account.get("name") or ""),
                "productTag": product_tag,
                "createdAt": int(delivery.get("createdAt") or now),
                "deliveredAt": now,
                "updatedAt": now,
            })

            for asset_id, asset in normalized_assets.items():
                conn.execute(
                    "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                    ("assets", asset_id, owner, now, json.dumps(asset, ensure_ascii=False)),
                )
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("assets", did, owner, now, json.dumps(delivery, ensure_ascii=False)),
            )
            conn.execute(
                "UPDATE docs SET updated_at=?,data=? WHERE collection='accounts' AND id=?",
                (now, json.dumps(account, ensure_ascii=False), account_id),
            )
            project["status"] = "published"
            project["publishedDeliveryId"] = did[:160]
            project["publishedAt"] = now
            project_state = (
                dict(project.get("projectState"))
                if isinstance(project.get("projectState"), dict)
                else {}
            )
            if kind == "video":
                source_output_id = str(delivery.get("sourceOutputId") or "").strip()[:180]
                if source_output_id:
                    published_outputs = (
                        dict(project_state.get("publishedVideoOutputs"))
                        if isinstance(project_state.get("publishedVideoOutputs"), dict)
                        else {}
                    )
                    published_outputs[source_output_id] = {
                        "deliveryId": did[:160],
                        "sourceDeliveryId": str(delivery.get("sourceDeliveryId") or "").strip()[:180],
                        "publishedAt": now,
                        "publishedCount": 1,
                    }
                    project_state["publishedVideoOutputs"] = dict(list(published_outputs.items())[-200:])
                    project["projectState"] = project_state
            elif kind == "canvas":
                project_state["publishedItemIds"] = sorted({
                    *[
                        str(value)[:180]
                        for value in (project_state.get("publishedItemIds") or [])[:200]
                        if str(value or "").strip()
                    ],
                    *[
                        str(value)[:180]
                        for value in (delivery.get("sourceItemIds") or [])[:20]
                        if str(value or "").strip()
                    ],
                })[:200]
                project["projectState"] = project_state
            project["updatedAt"] = now
            conn.execute(
                "UPDATE docs SET updated_at=?,data=? WHERE collection='customProjects' AND id=? AND owner_id=?",
                (now, json.dumps(project, ensure_ascii=False), pid, owner),
            )
            conn.commit()
            project_result = dict(project)
            project_result["publishedCount"] = _published_custom_delivery_counts_locked(
                conn,
                owner,
            ).get(pid, 0)
            return _custom_publish_result(project_result, account, delivery), None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _delivery_references_asset(delivery, asset_id):
    if not isinstance(delivery, dict) or not delivery.get("delivered"):
        return False
    if str(delivery.get("coverAssetId") or "") == asset_id:
        return True
    return asset_id in {
        str(value) for value in (delivery.get("packAssetIds") or []) if value
    }


def unpublish_custom_project_delivery(project_id, owner_id, delivery_id):
    """原子回撤交付、账号进度、供应商可见共享项和数据分析关联。"""
    _ensure_db()
    pid = str(project_id or "").strip()
    owner = str(owner_id or "")
    did = str(delivery_id or "").strip()
    if not pid or not did:
        return None, "invalid_publish_request"
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = _custom_project_row(pid, conn)
            if not row:
                return None, "not_found"
            stored_owner, project = row
            if stored_owner != owner:
                return None, "forbidden"
            delivery_row = conn.execute(
                "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                (did,),
            ).fetchone()
            if not delivery_row:
                tombstone = conn.execute(
                    "SELECT 1 FROM deleted_docs WHERE collection='assets' AND id=?",
                    (did,),
                ).fetchone()
                if tombstone and str(project.get("publishedDeliveryId") or "") != did:
                    conn.rollback()
                    project_result = dict(project)
                    project_result["publishedCount"] = _published_custom_delivery_counts_locked(
                        conn,
                        owner,
                    ).get(pid, 0)
                    return {
                        "project": project_result,
                        "account": None,
                        "deliveryId": did,
                        "unsharedAssetIds": [],
                        "removedAnalyticsIds": [],
                    }, None
                return None, "delivery_not_found"
            try:
                delivery = json.loads(delivery_row[1])
            except (TypeError, json.JSONDecodeError):
                return None, "delivery_not_found"
            if (
                delivery_row[0] != owner
                or not delivery.get("delivered")
                or str(delivery.get("customProjectId") or "") != pid
                or str(delivery.get("byMemberId") or "") != owner
            ):
                return None, "delivery_mismatch"
            retract_error = _custom_delivery_retract_error(delivery)
            if retract_error:
                return None, retract_error

            account_id = str(delivery.get("accountId") or "").strip()
            account_row = conn.execute(
                "SELECT owner_id,data FROM docs WHERE collection='accounts' AND id=?",
                (account_id,),
            ).fetchone()
            account = None
            if account_row:
                try:
                    account = json.loads(account_row[1])
                except (TypeError, json.JSONDecodeError):
                    account = None
            if account is not None:
                account["monthlyDone"] = max(
                    0, _int_at_least_zero(account.get("monthlyDone")) - 1
                )
                account["updatedAt"] = now
                conn.execute(
                    "UPDATE docs SET updated_at=?,data=? WHERE collection='accounts' AND id=?",
                    (now, json.dumps(account, ensure_ascii=False), account_id),
                )

            kind = str(project.get("kind") or delivery.get("customOutputKind") or "").strip().lower()
            _, shared_dependency_ids = _custom_delivery_dependencies(kind, delivery)
            shared_dependency_ids = shared_dependency_ids or set()
            conn.execute(
                "DELETE FROM docs WHERE collection='assets' AND id=? AND owner_id=?",
                (did, owner),
            )
            conn.execute(
                "INSERT OR REPLACE INTO deleted_docs(collection,id,deleted_at) VALUES(?,?,?)",
                ("assets", did, now),
            )

            removed_analytics_ids = []
            removed_snapshot_ids = set()
            published_url = str(delivery.get("publishedUrl") or "").strip()
            for link_id, raw in conn.execute(
                "SELECT id,data FROM docs WHERE collection='analyticsLinks'"
            ).fetchall():
                try:
                    link = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if (
                    str(link.get("assetId") or "") != did
                    and not (published_url and str(link.get("url") or "") == published_url)
                ):
                    continue
                removed_analytics_ids.append(str(link_id))
                conn.execute(
                    "DELETE FROM docs WHERE collection='analyticsLinks' AND id=?",
                    (str(link_id),),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO deleted_docs(collection,id,deleted_at) VALUES(?,?,?)",
                    ("analyticsLinks", str(link_id), now),
                )
            if removed_analytics_ids:
                for snapshot_id, raw in conn.execute(
                    "SELECT id,data FROM docs WHERE collection='metricSnapshots'"
                ).fetchall():
                    try:
                        snapshot = json.loads(raw)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if (
                        str(snapshot.get("linkId") or "") not in removed_analytics_ids
                        and str(snapshot.get("assetId") or "") != did
                    ):
                        continue
                    removed_snapshot_ids.add(str(snapshot_id))
                    conn.execute(
                        "DELETE FROM docs WHERE collection='metricSnapshots' AND id=?",
                        (str(snapshot_id),),
                    )
                    conn.execute(
                        "INSERT OR REPLACE INTO deleted_docs(collection,id,deleted_at) VALUES(?,?,?)",
                        ("metricSnapshots", str(snapshot_id), now),
                    )
                if removed_snapshot_ids:
                    for report_id, report_owner, raw in conn.execute(
                        "SELECT id,owner_id,data FROM docs WHERE collection='insightReports'"
                    ).fetchall():
                        try:
                            report = json.loads(raw)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        linked = [
                            str(value) for value in (report.get("linkedSnapshotIds") or [])
                            if value and str(value) not in removed_snapshot_ids
                        ]
                        if linked == [
                            str(value) for value in (report.get("linkedSnapshotIds") or []) if value
                        ]:
                            continue
                        report["linkedSnapshotIds"] = linked
                        report["updatedAt"] = now
                        conn.execute(
                            "UPDATE docs SET updated_at=?,data=? WHERE collection='insightReports' AND id=?",
                            (now, json.dumps(report, ensure_ascii=False), str(report_id)),
                        )
            conn.execute("DELETE FROM supplier_activity WHERE asset_id=?", (did,))

            remaining_deliveries = []
            for (raw,) in conn.execute(
                "SELECT data FROM docs WHERE collection='assets'"
            ).fetchall():
                try:
                    item = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if item.get("delivered"):
                    remaining_deliveries.append(item)

            unshared_asset_ids = []
            for asset_id in sorted(shared_dependency_ids):
                asset_row = conn.execute(
                    "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                    (asset_id,),
                ).fetchone()
                if not asset_row or asset_row[0] != owner:
                    continue
                try:
                    asset = json.loads(asset_row[1])
                except (TypeError, json.JSONDecodeError):
                    continue
                refs = [
                    str(item.get("id") or "")
                    for item in remaining_deliveries
                    if _delivery_references_asset(item, asset_id)
                ]
                if refs:
                    asset["customDeliveryShareRefs"] = refs
                else:
                    if not asset.get("sharedBeforeCustomDelivery"):
                        if asset.get("shared"):
                            unshared_asset_ids.append(asset_id)
                        asset["shared"] = False
                        asset.pop("sharedAt", None)
                        asset.pop("sharedSource", None)
                    asset.pop("customDeliveryShareRefs", None)
                    asset.pop("sharedBeforeCustomDelivery", None)
                asset["updatedAt"] = now
                conn.execute(
                    "UPDATE docs SET updated_at=?,data=? WHERE collection='assets' AND id=?",
                    (now, json.dumps(asset, ensure_ascii=False), asset_id),
                )

            candidates = [
                item for item in remaining_deliveries
                if (
                    str(item.get("customProjectId") or "") == pid
                    and str(item.get("byMemberId") or "") == owner
                )
            ]
            candidates.sort(
                key=lambda item: (
                    _int_at_least_zero(item.get("deliveredAt") or item.get("createdAt")),
                    _int_at_least_zero(item.get("pubSeq")),
                ),
                reverse=True,
            )
            project_state = (
                dict(project.get("projectState"))
                if isinstance(project.get("projectState"), dict)
                else {}
            )
            if project.get("kind") == "video":
                published_video_outputs = {}
                for candidate in candidates:
                    source_output_id = str(candidate.get("sourceOutputId") or "").strip()[:180]
                    if not source_output_id or source_output_id in published_video_outputs:
                        continue
                    published_video_outputs[source_output_id] = {
                        "deliveryId": str(candidate.get("id") or "")[:160],
                        "sourceDeliveryId": str(candidate.get("sourceDeliveryId") or "").strip()[:180],
                        "publishedAt": int(candidate.get("deliveredAt") or candidate.get("createdAt") or now),
                        "publishedCount": 1,
                    }
                project_state["publishedVideoOutputs"] = published_video_outputs
                project["projectState"] = project_state
            if candidates:
                project["status"] = "published"
                project["publishedDeliveryId"] = str(candidates[0].get("id") or "")[:160]
                project["publishedAt"] = int(
                    candidates[0].get("deliveredAt")
                    or candidates[0].get("createdAt")
                    or now
                )
                if project.get("kind") == "canvas":
                    project_state["publishedItemIds"] = sorted({
                        str(value)[:180]
                        for candidate in candidates
                        for value in (candidate.get("sourceItemIds") or [])[:20]
                        if str(value or "").strip()
                    })[:200]
                    project["projectState"] = project_state
            else:
                project["status"] = "draft"
                project["publishedDeliveryId"] = ""
                project.pop("publishedAt", None)
                if project.get("kind") == "canvas":
                    project_state.pop("publishedItemIds", None)
                    project["projectState"] = project_state
            project["updatedAt"] = now
            conn.execute(
                "UPDATE docs SET updated_at=?,data=? WHERE collection='customProjects' AND id=? AND owner_id=?",
                (now, json.dumps(project, ensure_ascii=False), pid, owner),
            )
            conn.commit()
            project_result = dict(project)
            project_result["publishedCount"] = len(candidates)
            return {
                "project": project_result,
                "account": account,
                "deliveryId": did,
                "unsharedAssetIds": unshared_asset_ids,
                "removedAnalyticsIds": removed_analytics_ids,
            }, None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _custom_video_project_id(workshop_project_id):
    digest = hashlib.sha256(str(workshop_project_id or "").encode("utf-8")).hexdigest()[:24]
    return f"video-workshop-{digest}"


def _custom_video_output_id(workshop_project_id, source_url, index):
    raw = f"{workshop_project_id}:{index}:{source_url}"
    return "video-output-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def _custom_video_proxy_url(value):
    url = str(value or "").strip()
    if url.startswith("/outputs/") or url.startswith("/uploads/"):
        return "/custom-video" + url
    return url


def find_custom_video_project(owner_id, workshop_project_id):
    """按视频工坊项目 ID 找到当前成员自己的主平台映射。"""
    target = str(workshop_project_id or "").strip()
    if not target:
        return None
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT data FROM docs WHERE collection='customProjects' AND owner_id=?",
                (str(owner_id),),
            ).fetchall()
            for (raw,) in rows:
                try:
                    item = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                state = item.get("projectState") if isinstance(item.get("projectState"), dict) else {}
                if item.get("kind") == "video" and str(state.get("workshopProjectId") or "") == target:
                    return item
            return None
        finally:
            conn.close()


def list_custom_video_project_ids(owner_id):
    return [
        str((item.get("projectState") or {}).get("workshopProjectId") or "")
        for item in list_custom_projects(owner_id, "video")
        if isinstance(item.get("projectState"), dict)
        and (item.get("projectState") or {}).get("integration") == "video-workshop"
        and (item.get("projectState") or {}).get("workshopProjectId")
    ]


def sync_custom_video_project(owner_id, workshop_project):
    """把视频工坊的轻量项目/成片元数据映射到 owner-scoped 定制项目。

    二进制和完整对话仍留在视频工坊目录；这里只有主平台统一发布所需的
    项目 ID、状态和输出 URL，避免复制 outputs/uploads 或把 Base64 写进 SQLite。
    """
    source = workshop_project if isinstance(workshop_project, dict) else {}
    workshop_project_id = str(source.get("id") or "").strip()
    if not workshop_project_id:
        return None, "invalid_workshop_project"
    existing = find_custom_video_project(owner_id, workshop_project_id)
    custom_project_id = (
        str(existing.get("id") or "")
        if existing
        else _custom_video_project_id(workshop_project_id)
    )
    plan = source.get("plan") if isinstance(source.get("plan"), dict) else {}
    raw_outputs = source.get("outputs") if isinstance(source.get("outputs"), list) else []
    sync_signature = hashlib.sha256(json.dumps({
        "name": source.get("name"),
        "status": source.get("status"),
        "phase": source.get("phase"),
        "progress": source.get("progress"),
        "updatedAt": source.get("updatedAt"),
        "planTitle": plan.get("title"),
        "planAspectRatio": plan.get("aspect_ratio"),
        "outputs": [
            {
                "label": item.get("label"),
                "aspectRatio": item.get("aspectRatio"),
                "url": item.get("url"),
                "downloadUrl": item.get("downloadUrl"),
                "id": item.get("id"),
                "deliveryId": item.get("deliveryId"),
                "probe": item.get("probe"),
            }
            for item in raw_outputs[:20]
            if isinstance(item, dict)
        ],
    }, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:24]
    existing_state = (
        existing.get("projectState")
        if existing and isinstance(existing.get("projectState"), dict)
        else {}
    )
    if existing_state.get("syncSignature") == sync_signature:
        return existing, None
    now = int(time.time() * 1000)
    output_docs = []
    for index, raw_output in enumerate(raw_outputs[:20]):
        if not isinstance(raw_output, dict):
            continue
        source_url = str(raw_output.get("url") or raw_output.get("downloadUrl") or "").strip()
        if not source_url:
            continue
        output_id = _custom_video_output_id(workshop_project_id, source_url, index)
        output_docs.append({
            "id": output_id,
            "ownerId": str(owner_id),
            "projectId": custom_project_id,
            "kind": "video",
            "source": "video-workshop",
            "sourceProjectId": workshop_project_id,
            "sourceDeliveryId": str(raw_output.get("deliveryId") or "")[:180],
            "sourceOutputId": str(raw_output.get("id") or output_id)[:180],
            "name": str(raw_output.get("label") or f"视频成片 {index + 1}")[:160],
            "mime": "video/mp4",
            "url": _custom_video_proxy_url(source_url),
            "downloadUrl": _custom_video_proxy_url(raw_output.get("downloadUrl") or source_url),
            "aspectRatio": str(raw_output.get("aspectRatio") or plan.get("aspect_ratio") or "9:16")[:24],
            "status": "ready" if source.get("status") == "succeeded" else "draft",
            "probe": raw_output.get("probe") if isinstance(raw_output.get("probe"), dict) else {},
            "createdAt": now,
            "updatedAt": now,
        })
    latest_output = output_docs[0] if output_docs else {}
    title = str(
        source.get("name")
        or plan.get("title")
        or (existing or {}).get("title")
        or "未命名视频项目"
    ).strip()[:120] or "未命名视频项目"
    try:
        progress = int(source.get("progress") or 0)
    except (TypeError, ValueError):
        progress = 0
    already_published = bool(
        existing
        and existing.get("status") == "published"
        and existing.get("publishedDeliveryId")
    )
    payload = {
        "kind": "video",
        "title": title,
        "appVersion": "video-workshop-sidecar-v1",
        "projectState": {
            "integration": "video-workshop",
            "workshopProjectId": workshop_project_id,
            "status": str(source.get("status") or "conversation")[:40],
            "phase": str(source.get("phase") or "brief")[:40],
            "progress": max(0, min(100, progress)),
            "aspectRatio": str(plan.get("aspect_ratio") or latest_output.get("aspectRatio") or "9:16")[:24],
            "outputCount": len(output_docs),
            "latestOutput": {
                key: latest_output.get(key)
                for key in ("id", "name", "url", "downloadUrl", "aspectRatio", "mime")
                if latest_output.get(key)
            },
            "sourceUpdatedAt": str(source.get("updatedAt") or "")[:80],
            "syncSignature": sync_signature,
            "publishedVideoOutputs": (
                dict(existing_state.get("publishedVideoOutputs"))
                if isinstance(existing_state.get("publishedVideoOutputs"), dict)
                else {}
            ),
        },
        "outputIds": [item["id"] for item in output_docs],
        "status": "published" if already_published else "draft",
        "publishedDeliveryId": (
            str(existing.get("publishedDeliveryId") or "")
            if already_published
            else ""
        ),
    }
    item, error = save_custom_project(owner_id, payload, custom_project_id)
    if error:
        return None, error
    if output_docs:
        upsert_docs("customOutputs", output_docs)
    item["publishedCount"] = count_custom_project_deliveries(
        item.get("id"),
        owner_id,
    )
    return item, None


def delete_custom_project(project_id, owner_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = _custom_project_row(project_id, conn)
            if not row:
                return False, "not_found"
            stored_owner, _ = row
            if stored_owner != str(owner_id):
                return False, "forbidden"
            now = int(time.time() * 1000)
            conn.execute(
                "DELETE FROM docs WHERE collection='customProjects' AND id=? AND owner_id=?",
                (str(project_id), str(owner_id)),
            )
            for collection in ("customOutputs", "customVideoJobs"):
                rows = conn.execute(
                    "SELECT id,data FROM docs WHERE collection=? AND owner_id=?",
                    (collection, str(owner_id)),
                ).fetchall()
                for doc_id, raw in rows:
                    try:
                        child = json.loads(raw)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    if str(child.get("projectId") or "") == str(project_id):
                        conn.execute(
                            "DELETE FROM docs WHERE collection=? AND id=?",
                            (collection, doc_id),
                        )
            conn.execute(
                "INSERT OR REPLACE INTO deleted_docs(collection,id,deleted_at) VALUES(?,?,?)",
                ("customProjects", str(project_id), now),
            )
            conn.commit()
            return True, None
        finally:
            conn.close()


def _delivery_asset_access(item, member_id, role, conn):
    if not isinstance(item, dict) or not item.get("delivered"):
        return False
    if role in {"admin", "supplier_parent", "supplier"}:
        return True
    if role == "supplier_child":
        assigned = {
            row[0] for row in conn.execute(
                "SELECT account_id FROM supplier_account_bindings WHERE child_id=?", (member_id,)
            ).fetchall()
        }
        return item.get("accountId") in assigned
    if role == "editor":
        if item.get("byMemberId") == member_id:
            return True
        production_id = str(item.get("productionId") or "")
        if not production_id:
            return False
        row = conn.execute(
            "SELECT owner_id,data FROM docs WHERE collection='productions' AND id=?", (production_id,)
        ).fetchone()
        if not row:
            return False
        if row[0] == member_id:
            return True
        try:
            return json.loads(row[1]).get("ownerId") == member_id
        except Exception:
            return False
    return False


def delivery_remarks(asset_id, member_id, role):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT data FROM docs WHERE collection='assets' AND id=?", (str(asset_id),)
            ).fetchone()
            if not row:
                return None, "not_found"
            item = json.loads(row[0])
            if not _delivery_asset_access(item, member_id, role, conn):
                return None, "forbidden"
            return {
                "remarks": list(item.get("remarks") or []),
                "remarkReadAt": dict(item.get("remarkReadAt") or {}),
                "latestRemarkAt": int(item.get("latestRemarkAt") or 0),
            }, None
        finally:
            conn.close()


def add_delivery_remark(asset_id, member, text):
    body = str(text or "").strip()
    if not body:
        return None, "empty"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT data,owner_id FROM docs WHERE collection='assets' AND id=?", (str(asset_id),)
            ).fetchone()
            if not row:
                return None, "not_found"
            item = json.loads(row[0])
            if not _delivery_asset_access(item, member["id"], member["role"], conn):
                return None, "forbidden"
            now = int(time.time() * 1000)
            remarks = list(item.get("remarks") or [])[-499:]
            remarks.append({
                "id": uuid.uuid4().hex[:12],
                "authorId": member["id"],
                "authorName": str(member.get("name") or "成员")[:60],
                "authorRole": member["role"],
                "text": body[:1200],
                "createdAt": now,
            })
            read_at = dict(item.get("remarkReadAt") or {})
            read_at[member["id"]] = now
            item["remarks"] = remarks
            item["remarkReadAt"] = read_at
            item["latestRemarkAt"] = now
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("assets", str(asset_id), row[1], now, json.dumps(item, ensure_ascii=False)),
            )
            conn.commit()
            return item, None
        finally:
            conn.close()


def mark_delivery_remarks_read(asset_id, member_id, role):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT data,owner_id FROM docs WHERE collection='assets' AND id=?", (str(asset_id),)
            ).fetchone()
            if not row:
                return None, "not_found"
            item = json.loads(row[0])
            if not _delivery_asset_access(item, member_id, role, conn):
                return None, "forbidden"
            now = int(time.time() * 1000)
            read_at = dict(item.get("remarkReadAt") or {})
            read_at[member_id] = max(now, int(item.get("latestRemarkAt") or 0))
            item["remarkReadAt"] = read_at
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("assets", str(asset_id), row[1], now, json.dumps(item, ensure_ascii=False)),
            )
            conn.commit()
            return item, None
        finally:
            conn.close()


def _delete_doc_in_conn(conn, collection, doc_id, protect_custom_delivery=False):
    did = str(doc_id)
    now = int(time.time() * 1000)
    if protect_custom_delivery and collection == "assets":
        row = conn.execute(
            "SELECT data FROM docs WHERE collection='assets' AND id=?",
            (did,),
        ).fetchone()
        if row:
            try:
                item = json.loads(row[0])
            except (TypeError, json.JSONDecodeError):
                item = {}
            if item.get("delivered") and item.get("customProjectId"):
                raise ValueError("custom_delivery_requires_unpublish")
    conn.execute("DELETE FROM docs WHERE collection=? AND id=?", (collection, did))
    conn.execute(
        "INSERT OR REPLACE INTO deleted_docs(collection,id,deleted_at) VALUES(?,?,?)",
        (collection, did, now),
    )


def delete_doc(collection, doc_id, protect_custom_delivery=False):
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            if collection == "assets":
                _clear_legacy_style_reference_locked(conn, doc_id)
            _delete_doc_in_conn(conn, collection, doc_id, protect_custom_delivery=protect_custom_delivery)
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


def update_supplier_account_views(account_id, view_count, member_id, role):
    """供应商母账号保存账号累计播放量；不拆分、不回写任何单条素材。"""
    if role not in {"supplier_parent", "supplier"}:
        return None, "forbidden"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT data,owner_id FROM docs WHERE collection='accounts' AND id=?", (str(account_id),)
            ).fetchone()
            if not row:
                return None, "not_found"
            item = json.loads(row[0])
            now = int(time.time() * 1000)
            item["totalViewCountOverride"] = max(0, int(view_count or 0))
            item["totalViewsUpdatedAt"] = now
            item["totalViewsUpdatedBy"] = member_id
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("accounts", str(account_id), row[1], now, json.dumps(item, ensure_ascii=False)),
            )
            conn.commit()
            return item, None
        finally:
            conn.close()


def _normalize_homepage_url(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    if any(ch.isspace() for ch in raw):
        raise ValueError("invalid_homepage_url")
    if "://" not in raw:
        raw = "https://" + raw
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("invalid_homepage_url")
    return parsed.geturl()


def update_supplier_account_homepage(account_id, homepage_url, member_id, role):
    """供应商母账号只更新账号主页字段；子账号没有账号编辑权限。"""
    if role not in {"supplier_parent", "supplier"}:
        return None, "forbidden"
    try:
        normalized = _normalize_homepage_url(homepage_url)
    except ValueError:
        return None, "invalid_url"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT data,owner_id FROM docs WHERE collection='accounts' AND id=?", (str(account_id),)
            ).fetchone()
            if not row:
                return None, "not_found"
            item = json.loads(row[0])
            now = int(time.time() * 1000)
            item["homepageUrl"] = normalized
            item["homepageUpdatedAt"] = now
            item["homepageUpdatedBy"] = member_id
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("accounts", str(account_id), row[1], now, json.dumps(item, ensure_ascii=False)),
            )
            conn.commit()
            return item, None
        finally:
            conn.close()


SUPPLIER_ACCOUNT_FIELDS = {
    "name", "platform", "mode", "subType", "position", "styleProfile", "tone",
    "monthlyDone", "exportSeq", "avatarAssetId",
    "imageStyleAssetId", "imagePromptTemplate", "homepageUrl", "appearanceAnchor",
    "lockedStyle", "customStyleChips", "status",
}
SUPPLIER_ACCOUNT_ASSET_FIELDS = {
    "id", "accountId", "seq", "ownerId", "name", "type", "tags", "createdAt",
    "updatedAt", "hasBlob", "contentHash", "fileUrl", "url", "mime", "size",
    "serverFileName", "storage", "processed", "blobUpdatedAt",
}


def _supplier_account_patch(data):
    source = data if isinstance(data, dict) else {}
    patch = {key: source.get(key) for key in SUPPLIER_ACCOUNT_FIELDS if key in source}
    patch["name"] = str(patch.get("name") or "").strip()
    patch["platform"] = str(patch.get("platform") or "小红书").strip()
    patch["mode"] = "图文" if patch.get("mode") == "图文" else "视频"
    patch["subType"] = "" if patch["mode"] == "图文" else (
        "无数字人" if patch.get("subType") == "无数字人" else "数字人"
    )
    if patch.get("homepageUrl") is not None:
        patch["homepageUrl"] = _normalize_homepage_url(patch.get("homepageUrl"))
    if patch.get("status") not in {"active", "disabled"}:
        patch["status"] = "active"
    return patch


def _supplier_account_assets(account_id, assets, member_id):
    """供应商只能随账号上传头像，不能借账号管理入口写入通用资产库。"""
    safe_assets = []
    for raw in assets or []:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        if "头像" not in {str(tag).strip() for tag in raw.get("tags") or []}:
            continue
        item = {key: raw.get(key) for key in SUPPLIER_ACCOUNT_ASSET_FIELDS if key in raw}
        item["id"] = str(raw.get("id"))
        item["accountId"] = str(account_id)
        item["ownerId"] = None
        server_name = str(item.get("serverFileName") or "")
        file_url = str(item.get("fileUrl") or item.get("url") or "")
        if not server_name.startswith(f"{member_id}--") or not file_url.startswith("/api/files/"):
            continue
        item["supplierManagedBy"] = member_id
        safe_assets.append(item)
    return safe_assets


def upsert_supplier_account(account_id, data, assets, member_id, *, create=False):
    """供应商管理员专用账号写入。

    只合并白名单业务字段，停用为可逆状态，永不删除历史产品、交付和资产。
    """
    try:
        patch = _supplier_account_patch(data)
    except ValueError:
        return None, "invalid_url"
    if not patch.get("name"):
        return None, "invalid"
    _ensure_db()
    now = int(time.time() * 1000)
    requested_id = str(account_id or "")
    doc_id = requested_id if re.fullmatch(r"[A-Za-z0-9_-]{6,80}", requested_id) else uuid.uuid4().hex[:10]
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT data FROM docs WHERE collection='accounts' AND id=?", (doc_id,)
            ).fetchone()
            if create and row:
                return None, "exists"
            if not create and not row:
                return None, "not_found"
            existing = json.loads(row[0]) if row else {}
            candidate = {**existing, **patch, "id": doc_id}
            # SQLite INSERT OR REPLACE 会生成新 rowid；供应商看板不能用该物理顺序
            # 重新编号。首次受供应商管理时固化当前投影编号，新建账号取下一个编号。
            candidate["index"] = _account_sequence(existing.get("index")) or (
                _projected_account_sequences([
                    json.loads(raw_data)
                    for (raw_data,) in conn.execute(
                        "SELECT data FROM docs WHERE collection='accounts' ORDER BY rowid"
                    ).fetchall()
                ]).get(doc_id, 0) if existing else _next_account_sequence(conn)
            )
            semantic_key = _account_semantic_key(candidate)
            duplicate = _existing_account_keys(conn).get(semantic_key) if semantic_key else None
            if duplicate and duplicate != doc_id:
                return None, "duplicate"
            if not existing:
                candidate.setdefault("createdAt", now)
                candidate.setdefault("monthlyDone", 0)
                candidate.setdefault("exportSeq", 0)
            candidate["updatedAt"] = now
            candidate["supplierManagedAt"] = now
            candidate["supplierManagedBy"] = member_id
            if candidate.get("status") == "disabled":
                candidate["disabledAt"] = existing.get("disabledAt") or now
                candidate["disabledBy"] = member_id
            else:
                candidate["status"] = "active"
                candidate.pop("disabledAt", None)
                candidate.pop("disabledBy", None)
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("accounts", doc_id, None, now, json.dumps(candidate, ensure_ascii=False)),
            )
            persisted_assets = []
            for asset in _supplier_account_assets(doc_id, assets, member_id):
                asset.setdefault("createdAt", now)
                asset["updatedAt"] = max(now, int(asset.get("updatedAt") or 0))
                conn.execute(
                    "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                    ("assets", asset["id"], None, asset["updatedAt"], json.dumps(asset, ensure_ascii=False)),
                )
                persisted_assets.append(asset)
            conn.commit()
            return {"account": candidate, "assets": persisted_assets}, None
        finally:
            conn.close()


def mark_supplier_asset_downloaded(asset_id, member_id, role):
    """只有真实供应商下载会写入供应商下载状态；创作端下载不经过此函数。"""
    if role not in {"supplier_parent", "supplier_child", "supplier"}:
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
            item["supplierDownloadedAt"] = now
            item["supplierDownloadedBy"] = member_id
            if not item.get("publishedUrl") and item.get("status") != "已发布":
                item["status"] = "已下载"
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("assets", str(asset_id), row[1], now, json.dumps(item, ensure_ascii=False)),
            )
            conn.commit()
            return item, None
        finally:
            conn.close()


def _normalize_published_url(value):
    raw = str(value or "").strip()
    if not raw or any(ch.isspace() for ch in raw):
        raise ValueError("invalid_published_url")
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("invalid_published_url")
    return parsed.geturl()


def _published_platform(url, fallback=""):
    value = str(url or "").lower()
    if any(term in value for term in ("xiaohongshu", "xhslink", "xhs")):
        return "小红书"
    if any(term in value for term in ("weixin", "wechat", "channels", "finder", "video.qq.com")):
        return "视频号"
    if any(term in value for term in ("douyin", "iesdouyin")):
        return "抖音"
    return str(fallback or "未知平台")


def update_supplier_asset_published_link(asset_id, published_url, note, title, raw_text, member_id, role):
    """供应商回传发布链接：原子更新交付资产与当前数据分析链接。"""
    if role not in {"supplier_parent", "supplier_child", "supplier"}:
        return None, None, "forbidden"
    try:
        normalized = _normalize_published_url(published_url)
    except ValueError:
        return None, None, "invalid_url"
    _ensure_db()
    assigned = supplier_account_ids_for_child(member_id) if role == "supplier_child" else None
    with _lock:
        conn = _connect()
        try:
            asset_row = conn.execute(
                "SELECT data,owner_id FROM docs WHERE collection='assets' AND id=?", (str(asset_id),)
            ).fetchone()
            if not asset_row:
                return None, None, "not_found"
            item = json.loads(asset_row[0])
            if not item.get("delivered") and not item.get("shared"):
                return None, None, "not_delivered"
            if assigned is not None and item.get("accountId") not in assigned:
                return None, None, "unassigned"

            now = int(time.time() * 1000)
            item["publishedUrl"] = normalized
            item["supplierNote"] = str(note or "").strip()[:300]
            if str(title or "").strip():
                item["publishedTitle"] = str(title).strip()[:240]
            item["publishedRawText"] = str(raw_text or "")[:500]
            item["publishedAt"] = now
            item["publishedUpdatedAt"] = now
            item["publishedUpdatedBy"] = member_id
            item["status"] = "已发布"
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("assets", str(asset_id), asset_row[1], now, json.dumps(item, ensure_ascii=False)),
            )

            account_platform = ""
            account_id = str(item.get("accountId") or "")
            if account_id:
                account_row = conn.execute(
                    "SELECT data FROM docs WHERE collection='accounts' AND id=?", (account_id,)
                ).fetchone()
                if account_row:
                    try:
                        account_platform = json.loads(account_row[0]).get("platform") or ""
                    except Exception:
                        account_platform = ""
            platform = _published_platform(normalized, account_platform)
            supported = platform in {"小红书", "视频号"}
            pending_message = "等待数据接口同步；未配置时仅保留发布回链、历史快照和本地复盘。"

            analytics_rows = conn.execute(
                "SELECT id,data,owner_id FROM docs WHERE collection='analyticsLinks'"
            ).fetchall()
            candidates = []
            for link_id, link_raw, link_owner in analytics_rows:
                try:
                    candidate = json.loads(link_raw)
                except Exception:
                    continue
                if str(candidate.get("assetId") or "") == str(asset_id) and candidate.get("status") != "superseded":
                    candidates.append((link_id, candidate, link_owner))
            candidates.sort(key=lambda row: int(row[1].get("updatedAt") or row[1].get("createdAt") or 0), reverse=True)
            current = candidates[0] if candidates else None

            if current and str(current[1].get("url") or "") != normalized:
                # 修改链接时直接覆盖当前分析条目，避免列表残留旧链接。旧快照不删除，
                # 只转为孤立归档，防止旧播放数据错误显示在新链接名下。
                current_link_id = current[0]
                snapshot_rows = conn.execute(
                    "SELECT id,data,owner_id FROM docs WHERE collection='metricSnapshots'"
                ).fetchall()
                for snapshot_id, snapshot_raw, snapshot_owner in snapshot_rows:
                    try:
                        snapshot = json.loads(snapshot_raw)
                    except Exception:
                        continue
                    if str(snapshot.get("linkId") or "") != str(current_link_id):
                        continue
                    snapshot["archivedLinkId"] = current_link_id
                    snapshot["linkId"] = f"archived:{current_link_id}:{now}"
                    snapshot["archivedAt"] = now
                    snapshot["updatedAt"] = now
                    conn.execute(
                        "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                        ("metricSnapshots", snapshot_id, snapshot_owner, now, json.dumps(snapshot, ensure_ascii=False)),
                    )
                for key in (
                    "lastSnapshotId", "lastSyncedAt", "noteId", "objectId", "objectNonceId",
                    "provider", "supersededAt",
                ):
                    current[1].pop(key, None)

            if current:
                link_id, link, link_owner = current
                link.update({
                    "url": normalized,
                    "platform": platform,
                    "accountId": item.get("accountId"),
                    "productionId": item.get("productionId"),
                    "assetId": item.get("id"),
                    "title": item.get("publishedTitle") or item.get("title") or item.get("name") or "",
                    "tags": item.get("tags") or [],
                    "publishedAt": item.get("publishedAt") or now,
                    "source": "supplier-return",
                    "updatedAt": now,
                })
                if not link.get("lastSnapshotId"):
                    link["status"] = "pending" if supported else "unsupported"
                    link["error"] = pending_message if supported else "该平台暂未接入数据监测。"
            else:
                link_id = uuid.uuid4().hex[:12]
                link_owner = None
                link = {
                    "id": link_id,
                    "url": normalized,
                    "platform": platform,
                    "accountId": item.get("accountId"),
                    "productionId": item.get("productionId"),
                    "assetId": item.get("id"),
                    "title": item.get("publishedTitle") or item.get("title") or item.get("name") or "",
                    "tags": item.get("tags") or [],
                    "publishedAt": item.get("publishedAt") or now,
                    "noteId": "",
                    "status": "pending" if supported else "unsupported",
                    "error": pending_message if supported else "该平台暂未接入数据监测。",
                    "source": "supplier-return",
                    "createdAt": now,
                    "updatedAt": now,
                }
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("analyticsLinks", link_id, link_owner, now, json.dumps(link, ensure_ascii=False)),
            )
            conn.commit()
            return item, link, None
        finally:
            conn.close()


def clear_supplier_asset_published_link(asset_id, member_id, role):
    """Clear a mistaken supplier return link without deleting its history.

    The delivery remains downloaded/delivered, while prior analytics records
    become archived (`superseded`) so they cannot be refreshed or counted as
    the current link.  Existing metric snapshots stay intact for audit.
    """
    if role not in {"supplier_parent", "supplier_child", "supplier"}:
        return None, None, "forbidden"
    _ensure_db()
    assigned = supplier_account_ids_for_child(member_id) if role == "supplier_child" else None
    with _lock:
        conn = _connect()
        try:
            asset_row = conn.execute(
                "SELECT data,owner_id FROM docs WHERE collection='assets' AND id=?", (str(asset_id),)
            ).fetchone()
            if not asset_row:
                return None, None, "not_found"
            item = json.loads(asset_row[0])
            if not item.get("delivered") and not item.get("shared"):
                return None, None, "not_delivered"
            if assigned is not None and item.get("accountId") not in assigned:
                return None, None, "unassigned"

            now = int(time.time() * 1000)
            for key in ("publishedUrl", "supplierNote", "publishedTitle", "publishedRawText", "publishedAt"):
                item.pop(key, None)
            item["publishedUpdatedAt"] = now
            item["publishedUpdatedBy"] = member_id
            item["publishedClearedAt"] = now
            item["status"] = "已下载" if item.get("supplierDownloadedAt") else "未下载"
            item["updatedAt"] = now
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("assets", str(asset_id), asset_row[1], now, json.dumps(item, ensure_ascii=False)),
            )

            archived_link = None
            for link_id, link_raw, link_owner in conn.execute(
                "SELECT id,data,owner_id FROM docs WHERE collection='analyticsLinks'"
            ).fetchall():
                try:
                    link = json.loads(link_raw)
                except Exception:
                    continue
                if str(link.get("assetId") or "") != str(asset_id) or link.get("status") == "superseded":
                    continue
                link["status"] = "superseded"
                link["supersededAt"] = now
                link["updatedAt"] = now
                link["error"] = "供应商已清除回传链接；历史数据仅保留存档。"
                conn.execute(
                    "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                    ("analyticsLinks", link_id, link_owner, now, json.dumps(link, ensure_ascii=False)),
                )
                archived_link = link
            conn.commit()
            return item, archived_link, None
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


def _projected_delivery_sequences(asset_items):
    """为缺少 pubSeq 的旧交付记录生成全局一致的只读序号投影。

    投影基于全量交付物计算，不会因供应商子账号的可见子集而重新连续编号；
    不写回 docs，因此不引入生产数据迁移或重写。现行记录仍以持久化 pubSeq 为权威值。
    """
    projected = {}
    used = set()
    legacy = []
    for item in asset_items:
        if not item.get("delivered"):
            continue
        doc_id = str(item.get("id") or "")
        if not doc_id:
            continue
        try:
            seq = int(item.get("pubSeq") or 0)
        except (TypeError, ValueError):
            seq = 0
        if seq > 0:
            projected[doc_id] = seq
            used.add(seq)
            continue
        try:
            delivered_at = int(item.get("deliveredAt") or item.get("createdAt") or item.get("updatedAt") or 0)
        except (TypeError, ValueError):
            delivered_at = 0
        legacy.append((delivered_at, doc_id))

    candidate = 1
    for _, doc_id in sorted(legacy):
        while candidate in used:
            candidate += 1
        projected[doc_id] = candidate
        used.add(candidate)
        candidate += 1
    return projected


def _global_delivery_sequences(asset_items):
    """按所有交付的真实交付时间计算同一套全局显示序号。

    该只读投影让管理员、创作者与供应商子账号即使只看见自己的子集，也会显示
    同一个编号；受控迁移完成后它会与持久化 pubSeq 完全一致。
    """
    delivered = []
    for item in asset_items:
        if not item.get("delivered"):
            continue
        doc_id = str(item.get("id") or "")
        if doc_id:
            delivered.append((_delivery_sequence_time(item), doc_id))
    return {doc_id: sequence for sequence, (_, doc_id) in enumerate(sorted(delivered), start=1)}


def _account_sequence(value):
    """读取账号的稳定编号；无效或缺失编号返回 0。"""
    try:
        sequence = int(value or 0)
    except (TypeError, ValueError):
        return 0
    return sequence if sequence > 0 else 0


def _projected_account_sequences(account_items):
    """为账号生成稳定编号，旧数据仍按初始顺序补位。

    已持久化编号优先。旧账号没有编号时，按原始行顺序占用尚未被持久化账号
    使用的位置；这样某个旧账号在停用 / 恢复写回后，即使 SQLite rowid 改变，
    其他账号也不会与它重号或整体换号。
    """
    projected = {}
    claimed = set()
    for item in account_items or []:
        account_id = str((item or {}).get("id") or "")
        sequence = _account_sequence((item or {}).get("index"))
        if account_id and sequence and sequence not in claimed:
            projected[account_id] = sequence
            claimed.add(sequence)
    next_sequence = 1
    for item in account_items or []:
        account_id = str((item or {}).get("id") or "")
        if not account_id or account_id in projected:
            continue
        while next_sequence in claimed:
            next_sequence += 1
        projected[account_id] = next_sequence
        claimed.add(next_sequence)
        next_sequence += 1
    return projected


def _next_account_sequence(conn):
    rows = conn.execute("SELECT data FROM docs WHERE collection='accounts' ORDER BY rowid").fetchall()
    items = []
    for (raw_data,) in rows:
        try:
            items.append(json.loads(raw_data))
        except (TypeError, json.JSONDecodeError):
            continue
    projected = _projected_account_sequences(items)
    return max(projected.values(), default=0) + 1


def state_for(member_id, role, parent_id=None, collections=None):
    """按成员可见性返回快照。

    ``collections`` 为 ``None`` 时保持历史全量语义；传入集合时只返回所需
    集合。过滤 assets/jobs 所需的 accounts/productions 会在服务端内部读取，
    但不会混入响应，避免轻量登录又退化成全量下载。
    """
    _ensure_db()
    requested = None if collections is None else {
        str(name) for name in collections if str(name) in COLLECTIONS
    }
    scan_collections = set(COLLECTIONS if requested is None else requested)
    if requested is not None:
        if "jobs" in requested:
            scan_collections.add("productions")
        if "assets" in requested:
            scan_collections.update({"accounts", "productions"})
        if role == "supplier_child" and "analyticsLinks" in requested:
            scan_collections.update({"accounts", "productions", "assets"})
    out = {}
    visible_prod_ids = set()
    assigned_account_ids = supplier_account_ids_for_child(member_id) if role == "supplier_child" else set()
    visible_asset_ids = set()
    supplier_avatar_asset_ids = set()
    editor_account_asset_ids = set()
    editor_delivery_asset_ids = set()
    supplier_production_created_at = {}
    account_projected_sequences = {}
    delivery_global_sequences = {}
    with _lock:
        conn = _connect()
        try:
            delivery_projected_sequences = {}
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
                if col not in scan_collections:
                    continue
                if role in {"supplier_parent", "supplier_child"} and col not in {"accounts", "assets"}:
                    out[col] = []
                    continue
                account_order = " ORDER BY rowid" if col == "accounts" else ""
                rows = conn.execute(
                    f"SELECT data, owner_id FROM docs WHERE collection=?{account_order}", (col,)
                ).fetchall()
                items = []
                if col == "accounts":
                    decoded_rows = [(json.loads(data), owner) for data, owner in rows]
                    account_projected_sequences = _projected_account_sequences(
                        [item for item, _ in decoded_rows]
                    )
                    row_items = decoded_rows
                elif col == "assets":
                    decoded_rows = [(json.loads(data), owner) for data, owner in rows]
                    delivery_projected_sequences = _projected_delivery_sequences([item for item, _ in decoded_rows])
                    delivery_global_sequences = _global_delivery_sequences([item for item, _ in decoded_rows])
                    if role == "editor":
                        for delivery, _ in decoded_rows:
                            if not delivery.get("delivered"):
                                continue
                            editor_delivery_asset_ids.update(
                                str(asset_id) for asset_id in [
                                    delivery.get("coverAssetId"),
                                    *(delivery.get("packAssetIds") or []),
                                ] if asset_id
                            )
                    row_items = decoded_rows
                else:
                    row_items = ((json.loads(data), owner) for data, owner in rows)
                for item, owner in row_items:
                    healed = False
                    if col == "productions":
                        item, healed = _heal_production_runtime_state(item)
                    if col in {
                        "sessions", "batches",
                        "customProjects", "customOutputs", "customVideoJobs",
                    } and owner and owner != member_id:
                        continue
                    if col == "accounts" and role == "supplier_child" and item.get("id") not in assigned_account_ids:
                        continue
                    if col == "accounts" and role == "editor":
                        editor_account_asset_ids.update(_account_reference_asset_ids(item))
                    if col == "accounts" and role in {"supplier_parent", "supplier_child"}:
                        # 供应商账号看板只需要账号头像。数字人角色版、参考声线和
                        # 其他创作侧管理资产不属于交付依赖，不能随账号快照向供应商
                        # 扩散；创作者侧仍通过上面的显式白名单获得必要资产。
                        if item.get("avatarAssetId"):
                            supplier_avatar_asset_ids.add(str(item.get("avatarAssetId")))
                        projected_account_sequence = account_projected_sequences.get(str(item.get("id") or ""))
                        if role == "supplier_child":
                            item = {
                                key: item.get(key) for key in (
                                    "id", "name", "platform", "mode", "subType", "avatarAssetId",
                                    "avatarUrl", "homepageUrl", "status", "disabledAt",
                                ) if item.get(key) is not None
                            }
                        if projected_account_sequence:
                            item["index"] = projected_account_sequence
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
                        try:
                            persisted_delivery_seq = int(item.get("pubSeq") or 0)
                        except (TypeError, ValueError):
                            persisted_delivery_seq = 0
                        if item.get("delivered"):
                            global_seq = delivery_global_sequences.get(str(item.get("id") or ""))
                            if global_seq:
                                item["globalSeq"] = global_seq
                        if item.get("delivered") and persisted_delivery_seq <= 0:
                            projected_seq = delivery_projected_sequences.get(str(item.get("id") or ""))
                            if projected_seq:
                                item["projectedSeq"] = projected_seq
                        if role in {"supplier_parent", "supplier_child"} and not item.get("sourceCreatedAt"):
                            item["sourceCreatedAt"] = supplier_production_created_at.get(str(item.get("productionId") or "")) or item.get("createdAt")
                        is_supplier_avatar = item.get("id") in supplier_avatar_asset_ids
                        if role == "supplier_child" and not is_supplier_avatar and ((not item.get("delivered") and not item.get("shared")) or item.get("accountId") not in assigned_account_ids):
                            continue
                        if role == "supplier_parent" and not is_supplier_avatar and not item.get("delivered") and not item.get("shared"):
                            continue
                        if (
                            role == "editor"
                            and not item.get("delivered")
                            and owner
                            and owner != member_id
                            and not _is_global_editing_asset(item)
                            and str(item.get("id") or "") not in editor_account_asset_ids
                            and str(item.get("id") or "") not in editor_delivery_asset_ids
                        ):
                            continue
                        if role not in {"supplier_child", "supplier_parent", "editor", "admin"} and owner and owner != member_id and not item.get("delivered") and not item.get("shared") and not _is_global_editing_asset(item):
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
    if requested is None or "jobs" in requested:
        out["jobs"] = [j for j in out.get("jobs", []) if j.get("productionId") in visible_prod_ids]
    if role == "supplier_child" and (requested is None or "analyticsLinks" in requested):
        out["analyticsLinks"] = [x for x in out.get("analyticsLinks", []) if x.get("assetId") in visible_asset_ids]
    if requested is not None:
        out = {name: out.get(name, []) for name in requested}
    return out
