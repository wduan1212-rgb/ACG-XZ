"""共享后端存储（Phase 1）：SQLite 文档表 + 成员表 + 口令哈希 + 无状态签名 token。

设计取舍：用「文档表」整条存 JSON，而不是给每类实体逐一建关系表——前端 schema 仍在演进，
文档存零映射、最稳，前端域模型一行不用改。团队规模够用；要扩 Postgres 时把本文件换实现即可（接口不变）。
"""
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Condition, Lock
from urllib.parse import unquote_to_bytes, urlparse

try:
    from . import config as runtime_config
except ImportError:  # 兼容以脚本方式直接运行
    import config as runtime_config

DB_PATH = Path(os.getenv("DATA_DB", Path(__file__).resolve().parent / "data.sqlite"))
CUSTOM_CANVAS_BLOB_DIR = Path(
    os.getenv("CUSTOM_CANVAS_BLOB_DIR", DB_PATH.parent / "canvas_blobs")
)
PRIVATE_MEDIA_UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", DB_PATH.parent / "uploads"))
PRIVATE_MEDIA_COMPOSED_DIR = Path(os.getenv("COMPOSED_DIR", DB_PATH.parent / "composed"))
_PRIVATE_MEDIA_VIDEO_ROOT = Path(
    os.getenv("VIDEO_WORKSHOP_ROOT", runtime_config.APP_DIR / "apps" / "video-workshop")
)
PRIVATE_MEDIA_VIDEO_OUTPUT_DIR = Path(
    os.getenv("VIDEO_WORKSHOP_OUTPUT_DIR", _PRIVATE_MEDIA_VIDEO_ROOT / "outputs")
)
PRIVATE_MEDIA_VIDEO_UPLOAD_DIR = Path(
    os.getenv("VIDEO_WORKSHOP_UPLOAD_DIR", _PRIVATE_MEDIA_VIDEO_ROOT / "uploads")
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
INTERNAL_TEAM_ID = "team-acg-marketing"
INTERNAL_TEAM_NAME = "ACG市场部"
TEAM_FEATURES = (
    "home", "dashboard", "studio", "batch", "video_workshop", "canvas",
    "voice", "assets", "delivery", "analytics", "team_members",
)
PERSONAL_FEATURES = (
    "home", "video_workshop", "canvas", "voice", "assets", "profile", "team_join"
)
TEAM_SEAT_LIMITS = {
    "team": 5,
    "team-pro": 10,
}
TEAM_SUPPLIER_ELIGIBLE_PLANS = {"team", "team-pro"}
CHINA_TZ = timezone(timedelta(hours=8))
PERSONAL_DAILY_POINTS = 70
SUBSCRIPTION_MONTHLY_POINTS = {
    "personal-pro": 2200,
    "personal-advanced": 3600,
    "team": 9000,
    "team-pro": 20000,
}
PERSONAL_SUBSCRIPTION_PLANS = {"personal-pro", "personal-advanced"}
TEAM_SUBSCRIPTION_PLANS = {"team", "team-pro"}
CUSTOM_CANVAS_GENERATION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000


def normalize_username(value):
    """用户名对外展示时仅去掉首尾空白。"""
    return str(value or "").strip()


def canonical_username(value):
    """用于查找与唯一性判定的稳定 key。

    不直接给旧表加唯一索引：部署前数据可能已有 Alice/alice
    这类大小写碰撞，强制索引会让服务启动迁移失败。新写入由
    同一事务内的 key 查询拦截，旧数据仍可登录和审计。
    """
    return normalize_username(value).casefold()

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
CREATE TABLE IF NOT EXISTS custom_canvas_blob_staging(
  owner_id     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY(owner_id, content_hash)
);
CREATE TABLE IF NOT EXISTS custom_canvas_generation_receipts(
  owner_id     TEXT NOT NULL,
  receipt_id   TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  points       INTEGER NOT NULL,
  feature      TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  charged_at   INTEGER,
  PRIMARY KEY(owner_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS idx_custom_canvas_generation_receipts_hash
  ON custom_canvas_generation_receipts(owner_id, content_hash, charged_at);
CREATE TABLE IF NOT EXISTS members(
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  username   TEXT NOT NULL UNIQUE,
  username_key TEXT NOT NULL DEFAULT '',
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
  username_key TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS teams(
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  slug         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'customer',
  status       TEXT NOT NULL DEFAULT 'active',
  plan         TEXT NOT NULL DEFAULT 'team',
  quota_mode   TEXT NOT NULL DEFAULT 'metered',
  created_at   INTEGER NOT NULL,
  created_by   TEXT
);
CREATE TABLE IF NOT EXISTS team_members(
  team_id     TEXT NOT NULL,
  member_id   TEXT NOT NULL UNIQUE,
  team_role   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  joined_at   INTEGER NOT NULL,
  added_by    TEXT,
  PRIMARY KEY(team_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team_role
  ON team_members(team_id, team_role, status);
CREATE TABLE IF NOT EXISTS personal_daily_quotas(
  member_id      TEXT NOT NULL,
  quota_day      TEXT NOT NULL,
  granted_points INTEGER NOT NULL,
  used_points    INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY(member_id, quota_day)
);
CREATE TABLE IF NOT EXISTS personal_daily_quota_events(
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL,
  quota_day       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT '',
  points          INTEGER NOT NULL,
  feature         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_daily_quota_events_member_day
  ON personal_daily_quota_events(member_id, quota_day, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_personal_daily_quota_events_idempotency
  ON personal_daily_quota_events(member_id, idempotency_key)
  WHERE idempotency_key <> '';
CREATE TABLE IF NOT EXISTS personal_daily_quota_reservations(
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL,
  quota_day       TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  points          INTEGER NOT NULL,
  feature         TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  settled_at      INTEGER,
  released_at     INTEGER,
  request_fingerprint TEXT NOT NULL DEFAULT '',
  UNIQUE(member_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_personal_quota_reservations_day_status
  ON personal_daily_quota_reservations(member_id, quota_day, status, created_at);
CREATE TABLE IF NOT EXISTS member_subscriptions(
  member_id     TEXT PRIMARY KEY,
  plan          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  activated_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  activated_by  TEXT
);
CREATE TABLE IF NOT EXISTS subscription_monthly_quotas(
  scope_type       TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  quota_month      TEXT NOT NULL,
  plan             TEXT NOT NULL,
  granted_points   INTEGER NOT NULL,
  purchased_points INTEGER NOT NULL DEFAULT 0,
  used_points      INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY(scope_type, scope_id, quota_month)
);
CREATE TABLE IF NOT EXISTS subscription_quota_events(
  id              TEXT PRIMARY KEY,
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  quota_month     TEXT NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT '',
  points          INTEGER NOT NULL,
  feature         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subscription_quota_events_scope_month
  ON subscription_quota_events(scope_type, scope_id, quota_month, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_quota_events_idempotency
  ON subscription_quota_events(scope_type, scope_id, idempotency_key)
  WHERE idempotency_key <> '';
CREATE TABLE IF NOT EXISTS subscription_quota_reservations(
  id                  TEXT PRIMARY KEY,
  scope_type          TEXT NOT NULL,
  scope_id            TEXT NOT NULL,
  member_id           TEXT NOT NULL,
  quota_month         TEXT NOT NULL,
  plan                TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  points              INTEGER NOT NULL,
  feature             TEXT NOT NULL,
  status              TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  settled_at          INTEGER,
  released_at         INTEGER,
  request_fingerprint TEXT NOT NULL DEFAULT '',
  UNIQUE(scope_type, scope_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_subscription_quota_reservations_scope_status
  ON subscription_quota_reservations(
    scope_type, scope_id, quota_month, status, created_at
  );
CREATE TABLE IF NOT EXISTS subscription_quota_topups(
  id              TEXT PRIMARY KEY,
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  quota_month     TEXT NOT NULL,
  points          INTEGER NOT NULL,
  entitlement_ref TEXT NOT NULL,
  activated_by    TEXT,
  created_at      INTEGER NOT NULL,
  UNIQUE(scope_type, scope_id, entitlement_ref)
);
CREATE TABLE IF NOT EXISTS video_generation_billing_tasks(
  id                   TEXT PRIMARY KEY,
  member_id            TEXT NOT NULL,
  idempotency_key      TEXT NOT NULL,
  request_fingerprint  TEXT NOT NULL,
  reservation_id       TEXT NOT NULL DEFAULT '',
  points               INTEGER NOT NULL,
  feature              TEXT NOT NULL,
  model                TEXT NOT NULL DEFAULT '',
  duration_seconds     INTEGER NOT NULL,
  provider_ref         TEXT NOT NULL DEFAULT '',
  provider              TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL,
  submit_response_json TEXT NOT NULL DEFAULT '{}',
  poll_result_json     TEXT NOT NULL DEFAULT '{}',
  billing_json         TEXT NOT NULL DEFAULT '{}',
  error                TEXT NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  settled_at           INTEGER,
  released_at          INTEGER,
  UNIQUE(member_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_generation_billing_provider_ref
  ON video_generation_billing_tasks(provider_ref)
  WHERE provider_ref <> '';
CREATE INDEX IF NOT EXISTS idx_video_generation_billing_member_status
  ON video_generation_billing_tasks(member_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS team_join_requests(
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  member_id   TEXT NOT NULL,
  status      TEXT NOT NULL,
  message     TEXT,
  created_at  INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_team_join_requests_team_status
  ON team_join_requests(team_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_join_requests_pending_member
  ON team_join_requests(team_id, member_id)
  WHERE status='pending';
CREATE TABLE IF NOT EXISTS team_suppliers(
  team_id            TEXT NOT NULL,
  supplier_parent_id TEXT NOT NULL UNIQUE,
  created_at         INTEGER NOT NULL,
  added_by           TEXT,
  PRIMARY KEY(team_id, supplier_parent_id)
);
CREATE TABLE IF NOT EXISTS team_accounts(
  team_id    TEXT NOT NULL,
  account_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  added_by   TEXT,
  PRIMARY KEY(team_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_team_accounts_team
  ON team_accounts(team_id, created_at);
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
CREATE TABLE IF NOT EXISTS community_posts(
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL,
  author_name TEXT NOT NULL,
  team_id     TEXT,
  source_kind TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  copy_text   TEXT NOT NULL DEFAULT '',
  prompt_text TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL,
  media_json  TEXT NOT NULL,
  cover_json  TEXT NOT NULL DEFAULT '{}',
  identity_key TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'published',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_community_posts_status_created
  ON community_posts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_posts_author_created
  ON community_posts(author_id, created_at DESC);
CREATE TABLE IF NOT EXISTS community_post_identities(
  author_id   TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  post_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY(author_id, identity_key)
);
CREATE INDEX IF NOT EXISTS idx_community_post_identities_post
  ON community_post_identities(post_id);
CREATE TABLE IF NOT EXISTS community_reactions(
  post_id      TEXT NOT NULL,
  member_id    TEXT NOT NULL,
  liked        INTEGER NOT NULL DEFAULT 0,
  favorited    INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY(post_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_community_reactions_member_favorite
  ON community_reactions(member_id, favorited, updated_at DESC);
"""

MIGRATION_LEDGER_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_migrations(
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  app_version TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '{}'
);
"""
MODEL_USAGE_RECEIPT_SCHEMA = """
CREATE TABLE IF NOT EXISTS model_usage_receipts(
  receipt_id          TEXT PRIMARY KEY,
  receipt_key         TEXT NOT NULL UNIQUE,
  member_id           TEXT NOT NULL,
  member_name         TEXT NOT NULL,
  team_id             TEXT NOT NULL DEFAULT '',
  surface             TEXT NOT NULL,
  feature             TEXT NOT NULL,
  usage_kind          TEXT NOT NULL,
  provider            TEXT NOT NULL DEFAULT '',
  model               TEXT NOT NULL DEFAULT '',
  operation           TEXT NOT NULL,
  operation_id        TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL DEFAULT '',
  request_fingerprint TEXT NOT NULL,
  provider_ref        TEXT NOT NULL DEFAULT '',
  call_status         TEXT NOT NULL,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  calls               INTEGER NOT NULL DEFAULT 0,
  output_units        INTEGER NOT NULL DEFAULT 0,
  unit_label          TEXT NOT NULL DEFAULT '',
  source              TEXT NOT NULL,
  error               TEXT NOT NULL DEFAULT '',
  event_at            INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_usage_receipts_member_idempotency
  ON model_usage_receipts(source, member_id, idempotency_key)
  WHERE idempotency_key<>'';
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_usage_receipts_provider_ref
  ON model_usage_receipts(provider, provider_ref, usage_kind)
  WHERE provider<>'' AND provider_ref<>'';
CREATE INDEX IF NOT EXISTS idx_model_usage_receipts_member_created
  ON model_usage_receipts(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_usage_receipts_status_updated
  ON model_usage_receipts(call_status, updated_at);
CREATE TABLE IF NOT EXISTS model_usage_outbox(
  receipt_id         TEXT PRIMARY KEY,
  state              TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  available_at       INTEGER NOT NULL,
  last_error         TEXT NOT NULL DEFAULT '',
  legacy_event_kind  TEXT NOT NULL DEFAULT '',
  legacy_event_id    TEXT NOT NULL DEFAULT '',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  projected_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_model_usage_outbox_state_available
  ON model_usage_outbox(state, available_at, created_at);
"""
RESOURCE_SCOPE_SCHEMA = """
CREATE TABLE IF NOT EXISTS resource_scopes(
  resource_kind TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  owner_id      TEXT NOT NULL DEFAULT '',
  provenance    TEXT NOT NULL,
  captured_at   INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY(resource_kind, resource_id),
  CHECK(scope_type IN ('team','member'))
);
CREATE INDEX IF NOT EXISTS idx_resource_scopes_scope
  ON resource_scopes(scope_type, scope_id, resource_kind);
CREATE TRIGGER IF NOT EXISTS trg_resource_scopes_docs_delete
AFTER DELETE ON docs
BEGIN
  DELETE FROM resource_scopes
  WHERE resource_kind=('doc:' || OLD.collection) AND resource_id=OLD.id;
END;
"""
PRIVATE_MEDIA_REGISTRY_SCHEMA = """
CREATE TABLE IF NOT EXISTS private_media_registry(
  media_kind      TEXT NOT NULL,
  media_key       TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  team_id         TEXT NOT NULL DEFAULT '',
  provenance_kind TEXT NOT NULL,
  provenance_id   TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(media_kind, media_key, owner_id),
  CHECK(media_kind IN (
    'upload','composed','canvas-blob','video-output','video-upload'
  ))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_private_media_single_owner
  ON private_media_registry(media_kind, media_key)
  WHERE media_kind<>'canvas-blob';
CREATE INDEX IF NOT EXISTS idx_private_media_owner
  ON private_media_registry(owner_id, media_kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_private_media_team
  ON private_media_registry(team_id, media_kind, updated_at DESC)
  WHERE team_id<>'';
"""
VIDEO_COMPOSE_OPERATION_SCHEMA = """
CREATE TABLE IF NOT EXISTS video_compose_operations(
  owner_id            TEXT NOT NULL,
  operation_key       TEXT NOT NULL,
  production_id       TEXT NOT NULL DEFAULT '',
  request_fingerprint TEXT NOT NULL,
  state               TEXT NOT NULL,
  claim_token         TEXT NOT NULL DEFAULT '',
  output_name         TEXT NOT NULL DEFAULT '',
  error               TEXT NOT NULL DEFAULT '',
  attempt              INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  PRIMARY KEY(owner_id, operation_key),
  CHECK(state IN ('running','succeeded','failed'))
);
CREATE INDEX IF NOT EXISTS idx_video_compose_operations_state_updated
  ON video_compose_operations(state, updated_at);
"""
# 137001/137002 were exercised by local pre-release builds before the v137
# schema identity was frozen.  Migration versions are immutable once written,
# even outside production, so the audited release advances to fresh numbers
# instead of overwriting an existing ledger checksum.
SCHEMA_MIGRATION_VERSION = 137003
SCHEMA_MIGRATION_NAME = "v137-schema-expand-final"
_SCHEMA_ALTERATIONS_IDENTITY = "|".join((
    "atomic-expand-transaction",
    "members.parent_id",
    "members.avatar_url",
    "members.username_key",
    "member_requests.username_key",
    "personal_daily_quota_reservations.request_fingerprint",
    "community_posts.cover_json",
    "community_posts.identity_key",
    "community_posts.author_identity_unique",
    "members.username_key_lookup",
    "member_requests.username_key_status_lookup",
))
SCHEMA_MIGRATION_CHECKSUM = hashlib.sha256(
    (SCHEMA + "\n" + _SCHEMA_ALTERATIONS_IDENTITY).encode("utf-8")
).hexdigest()
MODEL_USAGE_SCHEMA_MIGRATION_VERSION = 139001
MODEL_USAGE_SCHEMA_MIGRATION_NAME = "v139-model-usage-receipt-outbox"
_MODEL_USAGE_SCHEMA_IDENTITY = "|".join((
    "pre-call-durable-intent",
    "terminal-success-failure-unknown",
    "source-member-idempotency-unique",
    "provider-reference-unique",
    "deterministic-legacy-projection",
    "sqlite-busy-bounded-retry",
    "legacy-ledgers-unchanged",
))
MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM = hashlib.sha256(
    (MODEL_USAGE_RECEIPT_SCHEMA + "\n" + _MODEL_USAGE_SCHEMA_IDENTITY).encode("utf-8")
).hexdigest()
RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION = 140001
RESOURCE_SCOPE_SCHEMA_MIGRATION_NAME = "v140-resource-scopes"
_RESOURCE_SCOPE_SCHEMA_IDENTITY = "|".join((
    "deny-by-default-doc-resources",
    "single-team-or-member-authority",
    "immutable-stable-resource-id",
    "delete-scope-with-document",
    "legacy-attribution-is-separate-data-migration",
))
RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM = hashlib.sha256(
    (RESOURCE_SCOPE_SCHEMA + "\n" + _RESOURCE_SCOPE_SCHEMA_IDENTITY).encode("utf-8")
).hexdigest()
PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION = 140003
PRIVATE_MEDIA_SCHEMA_MIGRATION_NAME = "v140-private-media-registry"
_PRIVATE_MEDIA_SCHEMA_IDENTITY = "|".join((
    "deny-by-default-direct-media-reads",
    "owner-or-current-team-access",
    "no-global-admin-bypass",
    "canvas-hash-may-have-multiple-owner-paths",
    "all-other-media-has-one-owner",
    "community-route-is-explicit-public-exception",
    "legacy-attribution-is-separate-data-migration",
))
PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM = hashlib.sha256(
    (PRIVATE_MEDIA_REGISTRY_SCHEMA + "\n" + _PRIVATE_MEDIA_SCHEMA_IDENTITY).encode("utf-8")
).hexdigest()
VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION = 140005
VIDEO_COMPOSE_SCHEMA_MIGRATION_NAME = "v140-video-compose-idempotency"
_VIDEO_COMPOSE_SCHEMA_IDENTITY = "|".join((
    "owner-operation-primary-key",
    "production-request-fingerprint",
    "atomic-running-claim",
    "success-replay-reuses-output",
    "failure-remains-retryable",
    "private-media-registration-and-success-atomic",
))
VIDEO_COMPOSE_SCHEMA_MIGRATION_CHECKSUM = hashlib.sha256(
    (VIDEO_COMPOSE_OPERATION_SCHEMA + "\n" + _VIDEO_COMPOSE_SCHEMA_IDENTITY).encode("utf-8")
).hexdigest()
LATEST_SCHEMA_MIGRATION_VERSION = VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION
EXPECTED_SCHEMA_TABLES = frozenset(
    re.findall(r"CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)", SCHEMA)
) | frozenset(
    re.findall(
        r"CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)",
        MODEL_USAGE_RECEIPT_SCHEMA,
    )
) | frozenset(
    re.findall(
        r"CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)",
        RESOURCE_SCOPE_SCHEMA,
    )
) | frozenset(
    re.findall(
        r"CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)",
        PRIVATE_MEDIA_REGISTRY_SCHEMA,
    )
) | frozenset(
    re.findall(
        r"CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)",
        VIDEO_COMPOSE_OPERATION_SCHEMA,
    )
) | {"schema_migrations"}
EXPECTED_SCHEMA_COLUMNS = {
    "members": {"parent_id", "avatar_url", "username_key"},
    "member_requests": {"username_key"},
    "personal_daily_quota_reservations": {"request_fingerprint"},
    "community_posts": {"cover_json", "identity_key"},
    "model_usage_receipts": {
        "receipt_key", "team_id", "surface", "usage_kind", "operation_id",
        "idempotency_key", "request_fingerprint", "provider_ref", "call_status",
        "source", "event_at", "completed_at",
    },
    "model_usage_outbox": {
        "state", "attempts", "available_at", "last_error", "legacy_event_id",
        "projected_at",
    },
    "resource_scopes": {
        "resource_kind", "resource_id", "scope_type", "scope_id", "owner_id",
        "provenance", "captured_at", "updated_at",
    },
    "private_media_registry": {
        "media_kind", "media_key", "owner_id", "team_id",
        "provenance_kind", "provenance_id", "created_at", "updated_at",
    },
    "video_compose_operations": {
        "owner_id", "operation_key", "production_id", "request_fingerprint",
        "state", "claim_token", "output_name", "error", "attempt",
        "created_at", "updated_at", "completed_at",
    },
}
ACG_DATA_MIGRATION_VERSION = 137004
ACG_DATA_MIGRATION_NAME = "v137-acg-internal-team-final"
ACG_MIGRATION_SCOPE_SCHEMA = """
CREATE TABLE IF NOT EXISTS acg_internal_migration_scope(
  resource_kind TEXT NOT NULL,
  resource_id   TEXT NOT NULL,
  target_role   TEXT NOT NULL DEFAULT '',
  captured_at   INTEGER NOT NULL,
  PRIMARY KEY(resource_kind, resource_id)
)
"""
_ACG_DATA_MIGRATION_IDENTITY = "|".join((
    "team-acg-marketing",
    "capture-existing-admin-editor",
    "capture-existing-supplier-parent",
    "capture-existing-accounts",
    "capture-identity-members-and-requests",
    "block-canonical-identity-collisions",
    "block-supplier-relationship-orphans",
    "preserve-pin-parent-original-docs",
    "skip-and-block-external-team-bindings",
    "idempotent-scope-v1",
))
ACG_DATA_MIGRATION_CHECKSUM = hashlib.sha256(
    (ACG_MIGRATION_SCOPE_SCHEMA + "\n" + _ACG_DATA_MIGRATION_IDENTITY).encode("utf-8")
).hexdigest()
RESOURCE_SCOPE_DATA_MIGRATION_VERSION = 140002
RESOURCE_SCOPE_DATA_MIGRATION_NAME = "v140-acg-resource-attribution"
RESOURCE_SCOPE_OVERRIDE_MANIFEST_FORMAT = "acg-resource-scope-overrides-v1"
RESOURCE_SCOPE_OVERRIDE_MANIFEST_MAX_BYTES = 512 * 1024
RESOURCE_SCOPE_OVERRIDE_MANIFEST_MAX_ENTRIES = 10_000
PRIVATE_MEDIA_OVERRIDE_MANIFEST_FORMAT = "acg-private-media-overrides-v1"
PRIVATE_MEDIA_OVERRIDE_MANIFEST_MAX_BYTES = 512 * 1024
PRIVATE_MEDIA_OVERRIDE_MANIFEST_MAX_ENTRIES = 10_000
PRIVATE_MEDIA_RUNTIME_SNAPSHOT_COMPLETE_COMPONENTS = frozenset({
    "database", "legacy-data", "uploads", "composed", "canvas-blobs",
    "model-usage-spool", "server-logs", "video-projects", "video-uploads",
    "video-outputs", "bgm-library", "model-cache", "runtime-env-public",
    "runtime-env-private", "runtime-env-v140", "systemd-main",
    "systemd-video", "nginx-site",
})
_RESOURCE_SCOPE_DATA_MIGRATION_IDENTITY = "|".join((
    "requires-acg-137004",
    "freeze-existing-doc-identities",
    "owner-account-reference-candidate-intersection",
    "archived-analytics-reference",
    "stale-secondary-reference-warning",
    "external-tenants-remain-external",
    "unknown-or-ambiguous-fail-closed",
    "explicit-override-manifest-v1",
    "override-file-sha256-and-frozen-database-state",
    "override-binds-fresh-backup-manifest",
    "preserve-doc-json-owner-and-credentials",
    "idempotent-frozen-scope-v1",
))
RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM = hashlib.sha256(
    _RESOURCE_SCOPE_DATA_MIGRATION_IDENTITY.encode("utf-8")
).hexdigest()
PRIVATE_MEDIA_DATA_MIGRATION_VERSION = 140004
PRIVATE_MEDIA_DATA_MIGRATION_NAME = "v140-private-media-attribution"
_PRIVATE_MEDIA_DATA_MIGRATION_IDENTITY = "|".join((
    "requires-private-media-schema-140003",
    "docs-and-server-provenance-only",
    "upload-member-prefix-is-authoritative",
    "canvas-row-owner-is-authoritative",
    "workshop-project-id-owner-is-authoritative",
    "community-author-is-public-provenance",
    "ambiguous-or-orphan-blocks-entire-apply",
    "operator-review-manifest-binds-db-path-logical-versions-and-backup",
    "runtime-snapshot-media-inventory-matches-live-path-size-mtime-and-sha256",
    "override-owner-scope-must-match-business-reference",
    "no-path-url-or-content-rewrite",
    "idempotent-frozen-attribution-v1",
))
PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM = hashlib.sha256(
    _PRIVATE_MEDIA_DATA_MIGRATION_IDENTITY.encode("utf-8")
).hexdigest()


class StoreNotReadyError(RuntimeError):
    """Raised when normal production startup sees an unapplied/dirty schema."""


class ModelUsageReceiptError(RuntimeError):
    """Base error for durable model-usage receipt operations."""


class ModelUsageReceiptConflict(ModelUsageReceiptError):
    """Raised when an idempotency credential is replayed with different input."""


class ModelUsageReceiptWriteError(ModelUsageReceiptError):
    """Raised after bounded SQLite busy/locked retries are exhausted."""


class ModelUsageCompletionSpoolError(ModelUsageReceiptError):
    """Base error for the SQLite-independent completion spool."""


class ModelUsageCompletionSpoolConflict(ModelUsageCompletionSpoolError):
    """Raised when one receipt is spooled with a different completion payload."""


class ModelUsageCompletionSpoolCorrupt(ModelUsageCompletionSpoolError):
    """Raised when a persisted completion envelope fails strict validation."""


class VideoComposeOperationConflict(RuntimeError):
    """One compose identity was replayed with a different request body."""


class VideoComposeOperationClaimLost(RuntimeError):
    """The caller no longer owns the durable compose attempt."""


_lock = Lock()
_model_usage_write_condition = Condition()
_model_usage_write_queue = []
_model_usage_write_active = False
_initialized = False
MODEL_USAGE_WRITE_RETRY_ATTEMPTS = 5
MODEL_USAGE_WRITE_RETRY_BASE_SECONDS = 0.03
MODEL_USAGE_WRITE_BUSY_TIMEOUT_MS = 100
MODEL_USAGE_WRITE_MAX_SECONDS = 1.25
MODEL_USAGE_WRITE_BATCH_WINDOW_SECONDS = 0.004
MODEL_USAGE_COMPLETION_SPOOL_VERSION = 1


def _connect(read_only=None):
    use_read_only = runtime_config.is_read_only() if read_only is None else bool(read_only)
    if use_read_only:
        uri = DB_PATH.expanduser().resolve(strict=False).as_uri() + "?mode=ro"
        conn = sqlite3.connect(uri, timeout=30, uri=True)
    else:
        conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA busy_timeout=5000")
    if use_read_only:
        conn.execute("PRAGMA query_only=ON")
    else:
        conn.execute("PRAGMA journal_mode=WAL")
    return conn


def _connect_migration_target():
    """Open the target without changing journal mode before backup binding."""

    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _connect_model_usage_write(*, busy_timeout_ms=MODEL_USAGE_WRITE_BUSY_TIMEOUT_MS):
    """Open the short-timeout connection used only by receipt transactions.

    Ordinary store connections intentionally retain their existing 30-second
    connect timeout and 5-second SQLite busy timeout.  Receipt writes use the
    already-initialized WAL database and must fail quickly enough for callers to
    avoid turning accounting into a long generation-path stall.
    """

    timeout_ms = max(1, min(int(busy_timeout_ms), MODEL_USAGE_WRITE_BUSY_TIMEOUT_MS))
    conn = sqlite3.connect(str(DB_PATH), timeout=timeout_ms / 1000)
    conn.execute(f"PRAGMA busy_timeout={timeout_ms}")
    return conn


def _seed_admin_locked(conn):
    if conn.execute("SELECT COUNT(*) FROM members").fetchone()[0] == 0:
        now = int(time.time() * 1000)
        conn.execute(
            "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (
                uuid.uuid4().hex[:10], "管理员", DEFAULT_ADMIN_USERNAME,
                canonical_username(DEFAULT_ADMIN_USERNAME), DEFAULT_ADMIN_PIN_HASH,
                "admin", None, now,
            ),
        )
        conn.execute(
            "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (
                uuid.uuid4().hex[:10], "供应商", DEFAULT_SUPPLIER_USERNAME,
                canonical_username(DEFAULT_SUPPLIER_USERNAME), DEFAULT_SUPPLIER_PIN_HASH,
                "supplier_parent", None, now + 1,
            ),
        )


def _ensure_admin_alias_locked(conn):
    admin = conn.execute(
        "SELECT id,pin_hash,role,name FROM members WHERE username_key=? "
        "ORDER BY CASE WHEN trim(username)=? THEN 0 ELSE 1 END,created_at,id LIMIT 1",
        (canonical_username(DEFAULT_ADMIN_USERNAME), normalize_username(DEFAULT_ADMIN_USERNAME)),
    ).fetchone()
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
            "UPDATE members SET username=?, username_key=?, name=?, pin_hash=?, role=? WHERE id=?",
            (
                DEFAULT_ADMIN_USERNAME, canonical_username(DEFAULT_ADMIN_USERNAME),
                "管理员", DEFAULT_ADMIN_PIN_HASH, "admin", old[0],
            ),
        )
        return
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO members(id,name,username,username_key,pin_hash,role,created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (
            uuid.uuid4().hex[:10], "管理员", DEFAULT_ADMIN_USERNAME,
            canonical_username(DEFAULT_ADMIN_USERNAME), DEFAULT_ADMIN_PIN_HASH, "admin", now,
        ),
    )


def _ensure_username_keys_locked(conn):
    """幂等补齐旧库 canonical key，保留旧的大小写碰撞记录。"""
    for table in ("members", "member_requests"):
        rows = conn.execute(
            f"SELECT id,username,COALESCE(username_key,'') FROM {table}"
        ).fetchall()
        updates = []
        for row_id, username, stored_key in rows:
            expected = canonical_username(username)
            if stored_key != expected:
                updates.append((expected, row_id))
        if updates:
            conn.executemany(
                f"UPDATE {table} SET username_key=? WHERE id=?",
                updates,
            )
    # 非唯一索引仅用于查找；旧数据有碰撞时不会导致启动失败。
    conn.execute("CREATE INDEX IF NOT EXISTS idx_members_username_key ON members(username_key)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_member_requests_username_key_status "
        "ON member_requests(username_key,status)"
    )


def _ensure_supplier_parent_role_locked(conn):
    """旧版曾把默认供应商账号保存为创作成员；只修正角色，不改账号、密码或业务数据。"""
    row = conn.execute(
        "SELECT id,role FROM members WHERE username_key=? "
        "ORDER BY CASE WHEN trim(username)=? THEN 0 ELSE 1 END,created_at,id LIMIT 1",
        (canonical_username(DEFAULT_SUPPLIER_USERNAME), normalize_username(DEFAULT_SUPPLIER_USERNAME)),
    ).fetchone()
    if row and row[1] != "supplier_parent":
        conn.execute("UPDATE members SET role='supplier_parent', parent_id=NULL WHERE id=?", (row[0],))


def _ensure_internal_team_locked(conn):
    """幂等归属现有生产账号，不复制或覆盖任何成员、素材、任务和供应商数据。"""
    now = int(time.time() * 1000)
    owner = conn.execute(
        "SELECT id FROM members WHERE username_key=? AND role='admin' "
        "ORDER BY CASE WHEN trim(username)=? THEN 0 ELSE 1 END,created_at,id LIMIT 1",
        (canonical_username(DEFAULT_ADMIN_USERNAME), normalize_username(DEFAULT_ADMIN_USERNAME)),
    ).fetchone()
    owner_id = owner[0] if owner else None
    conn.execute(
        "INSERT OR IGNORE INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
        "VALUES(?,?,?,?,?,?,?,?,?)",
        (
            INTERNAL_TEAM_ID, INTERNAL_TEAM_NAME, "acg-marketing", "internal",
            "active", "team-pro", "unlimited", now, owner_id,
        ),
    )
    conn.execute(
        "UPDATE teams SET name=?,kind='internal',status='active',plan='team-pro',quota_mode='unlimited' "
        "WHERE id=?",
        (INTERNAL_TEAM_NAME, INTERNAL_TEAM_ID),
    )
    # The platform owner is a durable invariant, not a one-time migration side
    # effect. Some databases already carried the v1 migration marker before the
    # current default administrator row was normalized, which left that account
    # appearing as a personal plan. Repair only the designated internal owner;
    # later personal registrations and unrelated administrators stay untouched.
    if owner_id:
        conn.execute(
            "INSERT OR IGNORE INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
            "VALUES(?,?,?,?,?,?)",
            (
                INTERNAL_TEAM_ID, owner_id, "owner", "active",
                now, owner_id,
            ),
        )
        conn.execute(
            "UPDATE team_members SET team_role='owner',status='active' "
            "WHERE team_id=? AND member_id=?",
            (INTERNAL_TEAM_ID, owner_id),
        )
    # 首次上线只收编部署前已经存在的管理员与创作者。后续注册的普通用户
    # 不会被这个幂等迁移自动加入内部团队。
    migration_done = conn.execute(
        "SELECT v FROM meta WHERE k='internal_team_members_migrated_v1'"
    ).fetchone()
    if not migration_done:
        rows = conn.execute(
            "SELECT id,username,role,created_at FROM members WHERE role IN ('admin','editor')"
        ).fetchall()
        for member_id, username, role, created_at in rows:
            team_role = (
                "owner" if role == "admin" and username == DEFAULT_ADMIN_USERNAME
                else "admin" if role == "admin"
                else "creator"
            )
            conn.execute(
                "INSERT OR IGNORE INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                "VALUES(?,?,?,?,?,?)",
                (
                    INTERNAL_TEAM_ID, member_id, team_role, "active",
                    int(created_at or now), owner_id,
                ),
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta(k,v) VALUES('internal_team_members_migrated_v1',?)",
            (str(now),),
        )
    # 供应商与内容账号仅在首次上线时建立归属关系，不改原 parent_id、绑定和
    # 业务记录。后续新建的外部团队资源必须由团队开通流程显式归属，不能在
    # 每次服务启动时被重新收编进平台内部团队。
    resource_migration_done = conn.execute(
        "SELECT v FROM meta WHERE k='internal_team_resources_migrated_v1'"
    ).fetchone()
    if not resource_migration_done:
        for (supplier_parent_id,) in conn.execute(
            "SELECT id FROM members WHERE role='supplier_parent'"
        ).fetchall():
            conn.execute(
                "INSERT OR IGNORE INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                "VALUES(?,?,?,?)",
                (INTERNAL_TEAM_ID, supplier_parent_id, now, owner_id),
            )
        for (account_id,) in conn.execute(
            "SELECT id FROM docs WHERE collection='accounts'"
        ).fetchall():
            conn.execute(
                "INSERT OR IGNORE INTO team_accounts(team_id,account_id,created_at,added_by) "
                "VALUES(?,?,?,?)",
                (INTERNAL_TEAM_ID, account_id, now, owner_id),
            )
        conn.execute(
            "INSERT OR REPLACE INTO meta(k,v) VALUES('internal_team_resources_migrated_v1',?)",
            (str(now),),
        )


def _execute_sql_script_locked(conn, script):
    """Execute a trusted multi-statement script without an implicit commit."""

    pending = ""
    for line in str(script or "").splitlines(keepends=True):
        pending += line
        if not sqlite3.complete_statement(pending):
            continue
        statement = pending.strip()
        pending = ""
        if statement:
            conn.execute(statement)
    if pending.strip():
        raise sqlite3.OperationalError("incomplete SQL migration statement")


def _apply_schema_locked(conn, *, begin_transaction=True):
    """Apply additive schema only; never seed accounts, roles or credentials."""

    # ``sqlite3.executescript`` commits before running a script, which would
    # release the write lock protecting the backup-manifest comparison.  Run
    # complete statements individually so validation and expansion stay in one
    # BEGIN IMMEDIATE transaction.
    if begin_transaction and not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    _execute_sql_script_locked(conn, SCHEMA)
    _execute_sql_script_locked(conn, MIGRATION_LEDGER_SCHEMA)
    member_cols = {r[1] for r in conn.execute("PRAGMA table_info(members)").fetchall()}
    if "parent_id" not in member_cols:
        conn.execute("ALTER TABLE members ADD COLUMN parent_id TEXT")
    if "avatar_url" not in member_cols:
        conn.execute("ALTER TABLE members ADD COLUMN avatar_url TEXT")
    if "username_key" not in member_cols:
        conn.execute("ALTER TABLE members ADD COLUMN username_key TEXT NOT NULL DEFAULT ''")
    request_cols = {
        r[1] for r in conn.execute("PRAGMA table_info(member_requests)").fetchall()
    }
    if "username_key" not in request_cols:
        conn.execute(
            "ALTER TABLE member_requests ADD COLUMN username_key TEXT NOT NULL DEFAULT ''"
        )
    reservation_cols = {
        r[1]
        for r in conn.execute(
            "PRAGMA table_info(personal_daily_quota_reservations)"
        ).fetchall()
    }
    if "request_fingerprint" not in reservation_cols:
        conn.execute(
            "ALTER TABLE personal_daily_quota_reservations "
            "ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''"
        )
    community_cols = {
        r[1] for r in conn.execute("PRAGMA table_info(community_posts)").fetchall()
    }
    if "cover_json" not in community_cols:
        conn.execute(
            "ALTER TABLE community_posts ADD COLUMN cover_json TEXT NOT NULL DEFAULT '{}'"
        )
    if "identity_key" not in community_cols:
        conn.execute(
            "ALTER TABLE community_posts ADD COLUMN identity_key TEXT NOT NULL DEFAULT ''"
        )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_members_username_key ON members(username_key)")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_member_requests_username_key_status "
        "ON member_requests(username_key,status)"
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_community_posts_author_identity "
        "ON community_posts(author_id, identity_key) "
        "WHERE status='published' AND identity_key<>''"
    )


def _apply_model_usage_schema_locked(conn, *, begin_transaction=True):
    """Apply only the v139 usage receipt expansion in its own transaction."""

    if begin_transaction and not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    _execute_sql_script_locked(conn, MODEL_USAGE_RECEIPT_SCHEMA)


def _apply_resource_scope_schema_locked(conn, *, begin_transaction=True):
    """Create the v140 registry without assigning any legacy resource."""

    if begin_transaction and not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    _execute_sql_script_locked(conn, RESOURCE_SCOPE_SCHEMA)


def _apply_private_media_schema_locked(conn, *, begin_transaction=True):
    """Create the v140 media registry without attributing legacy files."""

    if begin_transaction and not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    _execute_sql_script_locked(conn, PRIVATE_MEDIA_REGISTRY_SCHEMA)


def _apply_video_compose_schema_locked(conn, *, begin_transaction=True):
    """Create the durable compose claim table without touching media rows."""

    if begin_transaction and not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    _execute_sql_script_locked(conn, VIDEO_COMPOSE_OPERATION_SCHEMA)


def _record_schema_migration_locked(conn, *, summary=None):
    existing = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    if existing and existing[0] != SCHEMA_MIGRATION_CHECKSUM:
        raise StoreNotReadyError("schema migration checksum mismatch")
    if existing and existing[1] == "success":
        return
    now = int(time.time() * 1000)
    encoded_summary = json.dumps(
        summary or {"schema": "expand-only"}, ensure_ascii=False
    )
    if existing:
        conn.execute(
            "UPDATE schema_migrations SET name=?,checksum=?,app_version=?,"
            "finished_at=?,status='success',summary=? WHERE version=?",
            (
                SCHEMA_MIGRATION_NAME,
                SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                encoded_summary,
                SCHEMA_MIGRATION_VERSION,
            ),
        )
    else:
        conn.execute(
            "INSERT INTO schema_migrations("
            "version,name,checksum,app_version,started_at,finished_at,status,summary"
            ") VALUES(?,?,?,?,?,?,?,?)",
            (
                SCHEMA_MIGRATION_VERSION,
                SCHEMA_MIGRATION_NAME,
                SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                now,
                "success",
                encoded_summary,
            ),
        )


def _record_model_usage_schema_migration_locked(conn, *, summary=None):
    existing = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (MODEL_USAGE_SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    if existing and existing[0] != MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM:
        raise StoreNotReadyError("model usage schema migration checksum mismatch")
    if existing and existing[1] == "success":
        return
    now = int(time.time() * 1000)
    encoded_summary = json.dumps(
        summary or {"schema": "model-usage-receipt-outbox", "mode": "expand-only"},
        ensure_ascii=False,
    )
    if existing:
        conn.execute(
            "UPDATE schema_migrations SET name=?,checksum=?,app_version=?,"
            "finished_at=?,status='success',summary=? WHERE version=?",
            (
                MODEL_USAGE_SCHEMA_MIGRATION_NAME,
                MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                encoded_summary,
                MODEL_USAGE_SCHEMA_MIGRATION_VERSION,
            ),
        )
    else:
        conn.execute(
            "INSERT INTO schema_migrations("
            "version,name,checksum,app_version,started_at,finished_at,status,summary"
            ") VALUES(?,?,?,?,?,?,?,?)",
            (
                MODEL_USAGE_SCHEMA_MIGRATION_VERSION,
                MODEL_USAGE_SCHEMA_MIGRATION_NAME,
                MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                now,
                "success",
                encoded_summary,
            ),
        )


def _record_resource_scope_schema_migration_locked(conn, *, summary=None):
    existing = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    if existing and existing[0] != RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM:
        raise StoreNotReadyError("resource scope schema migration checksum mismatch")
    if existing and existing[1] == "success":
        return
    now = int(time.time() * 1000)
    encoded_summary = json.dumps(
        summary or {"schema": "resource-scopes", "mode": "expand-only"},
        ensure_ascii=False,
    )
    if existing:
        conn.execute(
            "UPDATE schema_migrations SET name=?,checksum=?,app_version=?,"
            "finished_at=?,status='success',summary=? WHERE version=?",
            (
                RESOURCE_SCOPE_SCHEMA_MIGRATION_NAME,
                RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                encoded_summary,
                RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
            ),
        )
    else:
        conn.execute(
            "INSERT INTO schema_migrations("
            "version,name,checksum,app_version,started_at,finished_at,status,summary"
            ") VALUES(?,?,?,?,?,?,?,?)",
            (
                RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                RESOURCE_SCOPE_SCHEMA_MIGRATION_NAME,
                RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                now,
                "success",
                encoded_summary,
            ),
        )


def _record_private_media_schema_migration_locked(conn, *, summary=None):
    existing = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    if existing and existing[0] != PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM:
        raise StoreNotReadyError("private media schema migration checksum mismatch")
    if existing and existing[1] == "success":
        return
    now = int(time.time() * 1000)
    encoded_summary = json.dumps(
        summary or {"schema": "private-media-registry", "mode": "expand-only"},
        ensure_ascii=False,
    )
    values = (
        PRIVATE_MEDIA_SCHEMA_MIGRATION_NAME,
        PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM,
        runtime_config.release_id() or "unidentified",
        now,
        encoded_summary,
        PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
    )
    if existing:
        conn.execute(
            "UPDATE schema_migrations SET name=?,checksum=?,app_version=?,"
            "finished_at=?,status='success',summary=? WHERE version=?",
            values,
        )
    else:
        conn.execute(
            "INSERT INTO schema_migrations("
            "name,checksum,app_version,finished_at,status,summary,version,started_at"
            ") VALUES(?,?,?,?,'success',?,?,?)",
            (
                PRIVATE_MEDIA_SCHEMA_MIGRATION_NAME,
                PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                encoded_summary,
                PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                now,
            ),
        )


def _record_video_compose_schema_migration_locked(conn, *, summary=None):
    existing = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    if existing and existing[0] != VIDEO_COMPOSE_SCHEMA_MIGRATION_CHECKSUM:
        raise StoreNotReadyError("video compose schema migration checksum mismatch")
    if existing and existing[1] == "success":
        return
    now = int(time.time() * 1000)
    encoded_summary = json.dumps(
        summary or {"schema": "video-compose-idempotency", "mode": "expand-only"},
        ensure_ascii=False,
    )
    values = (
        VIDEO_COMPOSE_SCHEMA_MIGRATION_NAME,
        VIDEO_COMPOSE_SCHEMA_MIGRATION_CHECKSUM,
        runtime_config.release_id() or "unidentified",
        now,
        encoded_summary,
        VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,
    )
    if existing:
        conn.execute(
            "UPDATE schema_migrations SET name=?,checksum=?,app_version=?,"
            "finished_at=?,status='success',summary=? WHERE version=?",
            values,
        )
    else:
        conn.execute(
            "INSERT INTO schema_migrations("
            "name,checksum,app_version,finished_at,status,summary,version,started_at"
            ") VALUES(?,?,?,?,'success',?,?,?)",
            (
                VIDEO_COMPOSE_SCHEMA_MIGRATION_NAME,
                VIDEO_COMPOSE_SCHEMA_MIGRATION_CHECKSUM,
                runtime_config.release_id() or "unidentified",
                now,
                encoded_summary,
                VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,
                now,
            ),
        )


def _database_identity(path):
    try:
        stat = Path(path).stat()
    except OSError:
        return ""
    raw = f"{stat.st_dev}:{stat.st_ino}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def _database_path_digest(path):
    resolved = Path(path).expanduser().resolve(strict=False)
    return hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()


def _database_logical_digest_locked(conn):
    """Hash logical schema/data while the caller holds a stable transaction."""

    digest = hashlib.sha256()
    for statement in conn.iterdump():
        encoded = statement.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def _database_review_state_locked(conn, *, backup_manifest_sha256=""):
    """Return the exact frozen DB state an operator-reviewed manifest binds."""

    return {
        "databaseIdentity": _database_identity(DB_PATH),
        "databasePathSha256": _database_path_digest(DB_PATH),
        "databaseLogicalSha256": _database_logical_digest_locked(conn),
        "schemaVersion": int(conn.execute("PRAGMA schema_version").fetchone()[0]),
        "userVersion": int(conn.execute("PRAGMA user_version").fetchone()[0]),
        "backupManifestSha256": str(backup_manifest_sha256 or "").strip().lower(),
    }


def _verify_migration_backup_binding_locked(conn, backup_binding):
    """Bind a production migration transaction to one verified v2 backup."""

    if not isinstance(backup_binding, dict):
        raise StoreNotReadyError("verified backup manifest binding is required")
    required = {
        "format", "verified", "manifestSha256", "sourceDatabase",
        "sourceIdentity", "sourcePathSha256", "sourceLogicalSha256",
        "sourceSchemaVersion", "sourceUserVersion", "backupSha256",
    }
    if set(backup_binding) != required:
        raise StoreNotReadyError("backup manifest binding fields are invalid")
    if backup_binding.get("format") != "acg-sqlite-backup-v2" \
            or backup_binding.get("verified") is not True:
        raise StoreNotReadyError("verified backup manifest v2 is required")
    for field, length in (
        ("manifestSha256", 64),
        ("sourceIdentity", 16),
        ("sourcePathSha256", 64),
        ("sourceLogicalSha256", 64),
        ("backupSha256", 64),
    ):
        value = str(backup_binding.get(field) or "").strip().lower()
        if len(value) != length or any(char not in "0123456789abcdef" for char in value):
            raise StoreNotReadyError(f"backup manifest {field} is invalid")
    if str(backup_binding.get("sourceDatabase") or "") != DB_PATH.name:
        raise StoreNotReadyError("backup source database name mismatch")
    actual_state = _database_review_state_locked(
        conn,
        backup_manifest_sha256=backup_binding.get("manifestSha256"),
    )
    actual_identity = actual_state["databaseIdentity"]
    if not hmac.compare_digest(
        str(backup_binding["sourceIdentity"]), actual_identity,
    ):
        raise StoreNotReadyError("backup source database identity mismatch")
    actual_path_digest = actual_state["databasePathSha256"]
    if not hmac.compare_digest(
        str(backup_binding["sourcePathSha256"]), actual_path_digest,
    ):
        raise StoreNotReadyError("backup source database path mismatch")
    actual_schema_version = actual_state["schemaVersion"]
    actual_user_version = actual_state["userVersion"]
    if actual_schema_version != int(backup_binding["sourceSchemaVersion"]):
        raise StoreNotReadyError("backup source schema version mismatch")
    if actual_user_version != int(backup_binding["sourceUserVersion"]):
        raise StoreNotReadyError("backup source user version mismatch")
    actual_logical_digest = actual_state["databaseLogicalSha256"]
    if not hmac.compare_digest(
        str(backup_binding["sourceLogicalSha256"]), actual_logical_digest,
    ):
        raise StoreNotReadyError("database changed after verified backup")
    return actual_state


def _verify_runtime_snapshot_binding(binding, *, required=False):
    """Validate the redacted result of runtime_snapshot.verify_snapshot."""

    if binding is None and not required:
        return {"manifestSha256": "", "mediaInventoryDigest": ""}
    required_fields = {
        "format", "verified", "profile", "manifestSha256", "componentNames",
        "mediaInventoryDigest",
    }
    if not isinstance(binding, dict) or set(binding) != required_fields:
        raise StoreNotReadyError("verified runtime snapshot binding is required")
    if (
        binding.get("format") != "acg-runtime-snapshot-binding-v1"
        or binding.get("verified") is not True
    ):
        raise StoreNotReadyError("verified runtime snapshot binding is invalid")
    digest = str(binding.get("manifestSha256") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise StoreNotReadyError("runtime snapshot manifest sha256 is invalid")
    media_digest = str(
        binding.get("mediaInventoryDigest") or ""
    ).strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", media_digest):
        raise StoreNotReadyError("runtime snapshot media inventory digest is invalid")
    components = binding.get("componentNames")
    if not isinstance(components, list) or components != sorted(set(components)):
        raise StoreNotReadyError("runtime snapshot component binding is invalid")
    media_components = {
        "database", "uploads", "composed", "canvas-blobs",
        "video-projects", "video-uploads", "video-outputs",
    }
    if not media_components.issubset(set(components)):
        raise StoreNotReadyError("runtime snapshot media components are incomplete")
    profile = str(binding.get("profile") or "")
    if profile not in {"", "acg-production-complete-v1"}:
        raise StoreNotReadyError("runtime snapshot profile is invalid")
    if runtime_config.is_production() and profile != "acg-production-complete-v1":
        raise StoreNotReadyError("production-complete runtime snapshot is required")
    if (
        profile == "acg-production-complete-v1"
        and set(components) != PRIVATE_MEDIA_RUNTIME_SNAPSHOT_COMPLETE_COMPONENTS
    ):
        raise StoreNotReadyError(
            "production runtime snapshot component set is incomplete"
        )
    return {
        "manifestSha256": digest,
        "mediaInventoryDigest": media_digest,
    }


def database_readiness():
    """Inspect schema and migration state through a URI ``mode=ro`` connection."""

    result = {
        "ok": False,
        "exists": DB_PATH.is_file(),
        "identity": _database_identity(DB_PATH),
        "quickCheck": "unavailable",
        "schemaVersion": None,
        "userVersion": None,
        "migrationVersion": None,
        "migrationDirty": 0,
        "modelUsageMigrationVersion": None,
        "modelUsageMigrationChecksum": "",
        "modelUsageUnresolved": 0,
        "modelUsageOutboxPending": 0,
        "modelUsageCompletionSpoolPending": 0,
        "modelUsageCompletionSpoolArchived": 0,
        "modelUsageCompletionSpoolCorrupt": 0,
        "modelUsageCompletionSpoolConflicts": 0,
        "missingTables": [],
        "missingColumns": {},
        "checksum": "",
        "authSecret": False,
        "internalTeam": False,
        "acgMigration": False,
        "acgMigrationVersion": None,
        "acgMigrationChecksum": "",
        "acgMigrationDrift": 0,
        "resourceScopeSchemaVersion": None,
        "resourceScopeSchemaChecksum": "",
        "resourceScopeMigration": False,
        "resourceScopeMigrationVersion": None,
        "resourceScopeMigrationChecksum": "",
        "resourceScopeCoverage": 0,
        "resourceScopeDocuments": 0,
        "resourceScopeMissing": 0,
        "resourceScopeOrphans": 0,
        "resourceScopeInvalidTargets": 0,
        "privateMediaSchemaVersion": None,
        "privateMediaSchemaChecksum": "",
        "privateMediaMigration": False,
        "privateMediaMigrationVersion": None,
        "privateMediaMigrationChecksum": "",
        "videoComposeSchemaVersion": None,
        "videoComposeSchemaChecksum": "",
    }
    spool_status = model_usage_completion_spool_status()
    result["modelUsageCompletionSpoolPending"] = spool_status["pending"]
    result["modelUsageCompletionSpoolArchived"] = spool_status["archived"]
    result["modelUsageCompletionSpoolCorrupt"] = spool_status["corrupt"]
    result["modelUsageCompletionSpoolConflicts"] = spool_status["conflicts"]
    if spool_status.get("error"):
        result["modelUsageCompletionSpoolError"] = spool_status["error"]
    if not DB_PATH.is_file():
        return result
    try:
        conn = _connect(read_only=True)
    except sqlite3.Error as exc:
        result["error"] = type(exc).__name__
        return result
    try:
        result["quickCheck"] = str(conn.execute("PRAGMA quick_check").fetchone()[0])
        result["schemaVersion"] = int(conn.execute("PRAGMA schema_version").fetchone()[0])
        result["userVersion"] = int(conn.execute("PRAGMA user_version").fetchone()[0])
        tables = {
            str(row[0]) for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        result["missingTables"] = sorted(EXPECTED_SCHEMA_TABLES - tables)
        missing_columns = {}
        for table, required in EXPECTED_SCHEMA_COLUMNS.items():
            if table not in tables:
                continue
            actual = {
                str(row[1]) for row in conn.execute(
                    f"PRAGMA table_info({table})"
                ).fetchall()
            }
            absent = sorted(required - actual)
            if absent:
                missing_columns[table] = absent
        result["missingColumns"] = missing_columns
        if "schema_migrations" in tables:
            base_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations "
                "WHERE version=?",
                (SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            usage_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations "
                "WHERE version=?",
                (MODEL_USAGE_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            scope_schema_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations "
                "WHERE version=?",
                (RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            media_schema_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations "
                "WHERE version=?",
                (PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            compose_schema_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations "
                "WHERE version=?",
                (VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            if base_row:
                result["migrationVersion"] = int(base_row[0])
                result["checksum"] = str(base_row[1] or "")[:16]
            if usage_row:
                result["migrationVersion"] = int(usage_row[0])
                result["checksum"] = str(usage_row[1] or "")[:16]
                result["modelUsageMigrationVersion"] = int(usage_row[0])
                result["modelUsageMigrationChecksum"] = str(usage_row[1] or "")[:16]
            if scope_schema_row:
                result["migrationVersion"] = int(scope_schema_row[0])
                result["checksum"] = str(scope_schema_row[1] or "")[:16]
                result["resourceScopeSchemaVersion"] = int(scope_schema_row[0])
                result["resourceScopeSchemaChecksum"] = str(
                    scope_schema_row[1] or ""
                )[:16]
            if media_schema_row:
                result["migrationVersion"] = int(media_schema_row[0])
                result["checksum"] = str(media_schema_row[1] or "")[:16]
                result["privateMediaSchemaVersion"] = int(media_schema_row[0])
                result["privateMediaSchemaChecksum"] = str(
                    media_schema_row[1] or ""
                )[:16]
            if compose_schema_row:
                result["migrationVersion"] = int(compose_schema_row[0])
                result["checksum"] = str(compose_schema_row[1] or "")[:16]
                result["videoComposeSchemaVersion"] = int(compose_schema_row[0])
                result["videoComposeSchemaChecksum"] = str(
                    compose_schema_row[1] or ""
                )[:16]
            result["migrationDirty"] = int(conn.execute(
                "SELECT COUNT(*) FROM schema_migrations WHERE status<>'success'"
            ).fetchone()[0] or 0)
            migration_ok = bool(
                base_row
                and base_row[1] == SCHEMA_MIGRATION_CHECKSUM
                and base_row[2] == "success"
                and usage_row
                and usage_row[1] == MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM
                and usage_row[2] == "success"
                and scope_schema_row
                and scope_schema_row[1] == RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM
                and scope_schema_row[2] == "success"
                and media_schema_row
                and media_schema_row[1] == PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM
                and media_schema_row[2] == "success"
                and compose_schema_row
                and compose_schema_row[1] == VIDEO_COMPOSE_SCHEMA_MIGRATION_CHECKSUM
                and compose_schema_row[2] == "success"
                and result["migrationDirty"] == 0
            )
        else:
            migration_ok = False
        if {"model_usage_receipts", "model_usage_outbox"}.issubset(tables):
            result["modelUsageUnresolved"] = int(conn.execute(
                "SELECT COUNT(*) FROM model_usage_receipts r "
                "LEFT JOIN model_usage_outbox o ON o.receipt_id=r.receipt_id "
                "WHERE r.call_status IN ('pending','unknown') "
                "OR (r.call_status='succeeded' AND COALESCE(o.state,'')<>'projected')"
            ).fetchone()[0] or 0)
            result["modelUsageOutboxPending"] = int(conn.execute(
                "SELECT COUNT(*) FROM model_usage_outbox "
                "WHERE state IN ('pending','retry')"
            ).fetchone()[0] or 0)
        if "meta" in tables:
            result["authSecret"] = bool(
                os.getenv("AUTH_SECRET")
                or conn.execute("SELECT 1 FROM meta WHERE k='auth_secret'").fetchone()
            )
        if {"teams", "meta"}.issubset(tables):
            team = conn.execute(
                "SELECT name,slug,kind,status,plan,quota_mode FROM teams WHERE id=?",
                (INTERNAL_TEAM_ID,),
            ).fetchone()
            markers = int(conn.execute(
                "SELECT COUNT(*) FROM meta WHERE k IN ("
                "'internal_team_members_migrated_v1',"
                "'internal_team_resources_migrated_v1')"
            ).fetchone()[0] or 0)
            result["internalTeam"] = bool(
                team
                and tuple(team) == (
                    INTERNAL_TEAM_NAME, "acg-marketing", "internal", "active",
                    "team-pro", "unlimited",
                )
                and markers == 2
            )
        if {"schema_migrations", "acg_internal_migration_scope"}.issubset(tables):
            data_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations WHERE version=?",
                (ACG_DATA_MIGRATION_VERSION,),
            ).fetchone()
            if data_row:
                result["acgMigrationVersion"] = int(data_row[0])
                result["acgMigrationChecksum"] = str(data_row[1] or "")[:16]
            drift = 0
            scope_count = int(conn.execute(
                "SELECT COUNT(*) FROM acg_internal_migration_scope"
            ).fetchone()[0] or 0)
            owner_scope_count = int(conn.execute(
                "SELECT COUNT(*) FROM acg_internal_migration_scope "
                "WHERE resource_kind='member' AND target_role='owner'"
            ).fetchone()[0] or 0)
            if scope_count == 0 or owner_scope_count != 1:
                drift += 1
            drift += int(conn.execute(
                "SELECT COUNT(*) FROM acg_internal_migration_scope s "
                "LEFT JOIN members m ON m.id=s.resource_id "
                "LEFT JOIN team_members tm ON tm.member_id=s.resource_id "
                "WHERE s.resource_kind='member' AND (m.id IS NULL "
                "OR tm.member_id IS NULL OR tm.team_id<>? "
                "OR tm.team_role<>s.target_role OR tm.status<>'active')",
                (INTERNAL_TEAM_ID,),
            ).fetchone()[0] or 0)
            owner_count = int(conn.execute(
                "SELECT COUNT(*) FROM team_members WHERE team_id=? "
                "AND team_role='owner' AND status='active'",
                (INTERNAL_TEAM_ID,),
            ).fetchone()[0] or 0)
            if owner_count != 1:
                drift += abs(owner_count - 1) or 1
            drift += int(conn.execute(
                "SELECT COUNT(*) FROM acg_internal_migration_scope s "
                "LEFT JOIN members m ON m.id=s.resource_id "
                "LEFT JOIN team_suppliers ts ON ts.supplier_parent_id=s.resource_id "
                "WHERE s.resource_kind='supplier' AND (m.id IS NULL "
                "OR m.role<>'supplier_parent' OR ts.supplier_parent_id IS NULL OR ts.team_id<>?)",
                (INTERNAL_TEAM_ID,),
            ).fetchone()[0] or 0)
            drift += int(conn.execute(
                "SELECT COUNT(*) FROM acg_internal_migration_scope s "
                "LEFT JOIN docs d ON d.collection='accounts' AND d.id=s.resource_id "
                "LEFT JOIN team_accounts ta ON ta.account_id=s.resource_id "
                "WHERE s.resource_kind='account' AND (d.id IS NULL "
                "OR ta.account_id IS NULL OR ta.team_id<>?)",
                (INTERNAL_TEAM_ID,),
            ).fetchone()[0] or 0)
            for username, username_key in conn.execute(
                "SELECT m.username,m.username_key FROM acg_internal_migration_scope s "
                "JOIN members m ON m.id=s.resource_id "
                "WHERE s.resource_kind='identity_member'"
            ).fetchall():
                if str(username_key or "") != canonical_username(username):
                    drift += 1
            missing_identity_members = conn.execute(
                "SELECT COUNT(*) FROM acg_internal_migration_scope s "
                "LEFT JOIN members m ON m.id=s.resource_id "
                "WHERE s.resource_kind='identity_member' AND m.id IS NULL"
            ).fetchone()[0]
            drift += int(missing_identity_members or 0)
            for username, username_key in conn.execute(
                "SELECT r.username,r.username_key FROM acg_internal_migration_scope s "
                "JOIN member_requests r ON r.id=s.resource_id "
                "WHERE s.resource_kind='identity_request'"
            ).fetchall():
                if str(username_key or "") != canonical_username(username):
                    drift += 1
            missing_identity_requests = conn.execute(
                "SELECT COUNT(*) FROM acg_internal_migration_scope s "
                "LEFT JOIN member_requests r ON r.id=s.resource_id "
                "WHERE s.resource_kind='identity_request' AND r.id IS NULL"
            ).fetchone()[0]
            drift += int(missing_identity_requests or 0)
            result["acgMigrationDrift"] = drift
            result["acgMigration"] = bool(
                data_row
                and data_row[1] == ACG_DATA_MIGRATION_CHECKSUM
                and data_row[2] == "success"
                and drift == 0
            )
        if {"schema_migrations", "resource_scopes", "docs"}.issubset(tables):
            resource_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations WHERE version=?",
                (RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
            ).fetchone()
            if resource_row:
                result["resourceScopeMigrationVersion"] = int(resource_row[0])
                result["resourceScopeMigrationChecksum"] = str(
                    resource_row[1] or ""
                )[:16]
            documents = int(conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0] or 0)
            scoped = int(conn.execute(
                "SELECT COUNT(*) FROM docs d JOIN resource_scopes s "
                "ON s.resource_kind=('doc:' || d.collection) AND s.resource_id=d.id"
            ).fetchone()[0] or 0)
            orphans = int(conn.execute(
                "SELECT COUNT(*) FROM resource_scopes s LEFT JOIN docs d "
                "ON s.resource_kind=('doc:' || d.collection) AND s.resource_id=d.id "
                "WHERE s.resource_kind LIKE 'doc:%' AND d.id IS NULL"
            ).fetchone()[0] or 0)
            invalid_targets = int(conn.execute(
                "SELECT COUNT(*) FROM resource_scopes s "
                "LEFT JOIN teams t ON s.scope_type='team' AND t.id=s.scope_id "
                "LEFT JOIN members m ON s.scope_type='member' AND m.id=s.scope_id "
                "WHERE (s.scope_type='team' AND (t.id IS NULL OR t.status<>'active')) "
                "OR (s.scope_type='member' AND m.id IS NULL)"
            ).fetchone()[0] or 0)
            result["resourceScopeDocuments"] = documents
            result["resourceScopeCoverage"] = scoped
            result["resourceScopeMissing"] = max(0, documents - scoped)
            result["resourceScopeOrphans"] = orphans
            result["resourceScopeInvalidTargets"] = invalid_targets
            result["resourceScopeMigration"] = bool(
                resource_row
                and resource_row[1] == RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM
                and resource_row[2] == "success"
                and scoped == documents
                and orphans == 0
                and invalid_targets == 0
            )
        if {"schema_migrations", "private_media_registry"}.issubset(tables):
            media_data_row = conn.execute(
                "SELECT version,checksum,status FROM schema_migrations WHERE version=?",
                (PRIVATE_MEDIA_DATA_MIGRATION_VERSION,),
            ).fetchone()
            if media_data_row:
                result["privateMediaMigrationVersion"] = int(media_data_row[0])
                result["privateMediaMigrationChecksum"] = str(
                    media_data_row[1] or ""
                )[:16]
            result["privateMediaMigration"] = bool(
                media_data_row
                and media_data_row[1] == PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM
                and media_data_row[2] == "success"
            )
        team_ok = (
            result["internalTeam"]
            and result["acgMigration"]
        ) or not runtime_config.require_internal_team()
        resource_scope_ok = (
            result["resourceScopeMigration"]
            or not runtime_config.require_resource_scopes()
        )
        result["ok"] = bool(
            result["quickCheck"] == "ok"
            and not result["missingTables"]
            and not missing_columns
            and migration_ok
            and result["authSecret"]
            and team_ok
            and resource_scope_ok
            and result["modelUsageCompletionSpoolCorrupt"] == 0
            and result["modelUsageCompletionSpoolConflicts"] == 0
        )
    except sqlite3.Error as exc:
        result["error"] = type(exc).__name__
    finally:
        conn.close()
    return result


def apply_schema_migrations(
    *, expected_identity="", backup_binding=None, migration_version=None,
):
    """Explicit expand-only migration entry used by ``python -m server.migrations``.

    This function deliberately does not seed members, normalize roles, rewrite
    PIN hashes or create ACG team ownership.  Those are separately approved data
    migrations and must never hide inside ordinary application startup.
    """

    global _initialized
    if runtime_config.is_read_only():
        raise StoreNotReadyError("read-only runtime cannot apply migrations")
    if runtime_config.runtime_mode() == "invalid":
        raise StoreNotReadyError("invalid ACG_RUNTIME_MODE")
    if str(os.getenv("ACG_ALLOW_SCHEMA_MIGRATION", "")).strip() != "1":
        raise StoreNotReadyError("schema migration authorization is required")
    if not DB_PATH.is_file():
        raise StoreNotReadyError("migration target database must already exist")
    actual_identity = _database_identity(DB_PATH)
    if runtime_config.is_production() and not hmac.compare_digest(
        str(expected_identity or ""), actual_identity,
    ):
        raise StoreNotReadyError("migration target database identity mismatch")
    with _lock:
        conn = _connect_migration_target()
        active_migration = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            locked_identity = _database_identity(DB_PATH)
            if runtime_config.is_production() and not hmac.compare_digest(
                str(expected_identity or ""), locked_identity,
            ):
                raise StoreNotReadyError("migration target database identity mismatch")
            if runtime_config.is_production():
                _verify_migration_backup_binding_locked(conn, backup_binding)
            quick_check = str(conn.execute("PRAGMA quick_check").fetchone()[0])
            if quick_check != "ok":
                raise StoreNotReadyError("migration target failed SQLite quick_check")
            _execute_sql_script_locked(conn, MIGRATION_LEDGER_SCHEMA)
            all_migrations = (
                (
                    SCHEMA_MIGRATION_VERSION,
                    SCHEMA_MIGRATION_NAME,
                    SCHEMA_MIGRATION_CHECKSUM,
                    _apply_schema_locked,
                    _record_schema_migration_locked,
                ),
                (
                    MODEL_USAGE_SCHEMA_MIGRATION_VERSION,
                    MODEL_USAGE_SCHEMA_MIGRATION_NAME,
                    MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM,
                    _apply_model_usage_schema_locked,
                    _record_model_usage_schema_migration_locked,
                ),
                (
                    RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    RESOURCE_SCOPE_SCHEMA_MIGRATION_NAME,
                    RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM,
                    _apply_resource_scope_schema_locked,
                    _record_resource_scope_schema_migration_locked,
                ),
                (
                    PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                    PRIVATE_MEDIA_SCHEMA_MIGRATION_NAME,
                    PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM,
                    _apply_private_media_schema_locked,
                    _record_private_media_schema_migration_locked,
                ),
                (
                    VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,
                    VIDEO_COMPOSE_SCHEMA_MIGRATION_NAME,
                    VIDEO_COMPOSE_SCHEMA_MIGRATION_CHECKSUM,
                    _apply_video_compose_schema_locked,
                    _record_video_compose_schema_migration_locked,
                ),
            )
            migrations = all_migrations
            if migration_version is not None:
                requested = int(migration_version)
                positions = {
                    version: index
                    for index, (version, _name, _checksum, _apply, _record)
                    in enumerate(all_migrations)
                }
                if requested not in positions:
                    raise StoreNotReadyError("unknown schema migration version")
                position = positions[requested]
                for prerequisite in all_migrations[:position]:
                    version, _name, checksum, _apply, _record = prerequisite
                    row = conn.execute(
                        "SELECT checksum,status FROM schema_migrations WHERE version=?",
                        (version,),
                    ).fetchone()
                    if row != (checksum, "success"):
                        raise StoreNotReadyError(
                            f"schema migration prerequisite {version} is not ready"
                        )
                migrations = (all_migrations[position],)
            applied_versions = []
            for version, name, checksum, apply_locked, record_locked in migrations:
                existing = conn.execute(
                    "SELECT checksum,status FROM schema_migrations WHERE version=?",
                    (version,),
                ).fetchone()
                if existing and existing[0] != checksum:
                    raise StoreNotReadyError(f"schema migration {version} checksum mismatch")
                if existing and existing[1] == "success":
                    continue
                if existing and existing[1] == "running":
                    raise StoreNotReadyError(f"schema migration {version} is already marked running")
                active_migration = (version, name, checksum)
                now = int(time.time() * 1000)
                conn.execute(
                    "INSERT OR REPLACE INTO schema_migrations("
                    "version,name,checksum,app_version,started_at,finished_at,status,summary"
                    ") VALUES(?,?,?,?,?,NULL,'running','{}')",
                    (
                        version,
                        name,
                        checksum,
                        runtime_config.release_id() or "unidentified",
                        now,
                    ),
                )
                apply_locked(conn, begin_transaction=False)
                record_locked(conn)
                applied_versions.append(version)
                active_migration = None
            conn.commit()
            _initialized = False
            return {
                "applied": bool(applied_versions),
                "version": (
                    int(migration_version)
                    if migration_version is not None
                    else LATEST_SCHEMA_MIGRATION_VERSION
                ),
                "appliedVersions": applied_versions,
            }
        except Exception as exc:
            conn.rollback()
            # Preserve an auditable failure marker without retaining any
            # partial schema writes.  Backup-binding failures happen before an
            # active migration is selected and therefore remain zero-write.
            if active_migration:
                version, name, checksum = active_migration
                try:
                    _execute_sql_script_locked(conn, MIGRATION_LEDGER_SCHEMA)
                    existing = conn.execute(
                        "SELECT checksum FROM schema_migrations WHERE version=?",
                        (version,),
                    ).fetchone()
                    if not existing or existing[0] == checksum:
                        now = int(time.time() * 1000)
                        conn.execute(
                            "INSERT OR REPLACE INTO schema_migrations("
                            "version,name,checksum,app_version,started_at,finished_at,status,summary"
                            ") VALUES(?,?,?,?,?,?,?,?)",
                            (
                                version, name, checksum,
                                runtime_config.release_id() or "unidentified",
                                now, now, "failed",
                                json.dumps({"error": type(exc).__name__}),
                            ),
                        )
                        conn.commit()
                except Exception:
                    conn.rollback()
            raise
        finally:
            conn.close()


def _table_exists_locked(conn, table):
    return bool(conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (str(table),),
    ).fetchone())


def _safe_table_count_locked(conn, table):
    if not _table_exists_locked(conn, table):
        return 0
    return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] or 0)


def _acg_record_totals_locked(conn):
    return {
        table: _safe_table_count_locked(conn, table)
        for table in (
            "members", "member_requests", "docs", "teams", "team_members",
            "team_suppliers", "team_accounts",
        )
    }


def _rows_digest(rows):
    digest = hashlib.sha256()
    for row in rows:
        digest.update(json.dumps(list(row), ensure_ascii=False, sort_keys=True).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


def _acg_protected_digests_locked(conn):
    """Hash fields this migration is forbidden to rewrite; values never leave memory."""

    members = conn.execute(
        "SELECT id,name,username,pin_hash,parent_id,avatar_url,created_at "
        "FROM members ORDER BY id"
    ).fetchall()
    requests = conn.execute(
        "SELECT id,name,username,pin_hash,role,status,message,created_at,"
        "reviewed_at,reviewed_by FROM member_requests ORDER BY id"
    ).fetchall()
    docs = conn.execute(
        "SELECT collection,id,owner_id,updated_at,data FROM docs "
        "ORDER BY collection,id"
    ).fetchall()
    return {
        "members": _rows_digest(members),
        "memberRequests": _rows_digest(requests),
        "docs": _rows_digest(docs),
    }


def _acg_scope_rows_locked(conn):
    if not _table_exists_locked(conn, "acg_internal_migration_scope"):
        return []
    return conn.execute(
        "SELECT resource_kind,resource_id,target_role "
        "FROM acg_internal_migration_scope ORDER BY resource_kind,resource_id"
    ).fetchall()


def _acg_data_migration_row_locked(conn):
    return conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (ACG_DATA_MIGRATION_VERSION,),
    ).fetchone()


def _acg_plan_locked(conn, owner_username, team_id):
    issues = []
    schema_row = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    if not schema_row or schema_row != (SCHEMA_MIGRATION_CHECKSUM, "success"):
        issues.append("schema_migration_not_ready")
    dirty_other = int(conn.execute(
        "SELECT COUNT(*) FROM schema_migrations "
        "WHERE status<>'success' AND version<>?",
        (ACG_DATA_MIGRATION_VERSION,),
    ).fetchone()[0] or 0)
    if dirty_other:
        issues.append("other_dirty_migrations")

    expected_owner = normalize_username(DEFAULT_ADMIN_USERNAME)
    confirmed_owner = normalize_username(owner_username)
    if canonical_username(confirmed_owner) != canonical_username(expected_owner):
        issues.append("owner_confirmation_mismatch")
    if str(team_id or "") != INTERNAL_TEAM_ID:
        issues.append("team_confirmation_mismatch")

    member_rows = conn.execute(
        "SELECT id,username,username_key,role,parent_id,created_at FROM members"
    ).fetchall()
    owner_rows = [
        row for row in member_rows
        if canonical_username(row[1]) == canonical_username(confirmed_owner)
        and str(row[3]) == "admin"
    ]
    if len(owner_rows) != 1:
        issues.append("owner_not_unique_admin")
        owner_id = ""
    else:
        owner_id = str(owner_rows[0][0])

    data_row = _acg_data_migration_row_locked(conn)
    if data_row and data_row[0] != ACG_DATA_MIGRATION_CHECKSUM:
        issues.append("acg_migration_checksum_mismatch")
    if data_row and data_row[1] == "running":
        issues.append("acg_migration_running")

    team = conn.execute(
        "SELECT name,slug,kind,status,plan,quota_mode FROM teams WHERE id=?",
        (INTERNAL_TEAM_ID,),
    ).fetchone()
    expected_team = (
        INTERNAL_TEAM_NAME, "acg-marketing", "internal", "active",
        "team-pro", "unlimited",
    )
    if team and tuple(team) != expected_team:
        issues.append("target_team_conflict")
    alias_conflict = conn.execute(
        "SELECT COUNT(*) FROM teams WHERE id<>? AND (name=? OR slug='acg-marketing')",
        (INTERNAL_TEAM_ID, INTERNAL_TEAM_NAME),
    ).fetchone()[0]
    if int(alias_conflict or 0):
        issues.append("target_team_alias_conflict")

    scope_rows = _acg_scope_rows_locked(conn)
    scope_captured = bool(scope_rows)
    if data_row and data_row[1] == "success" and not scope_captured:
        issues.append("acg_scope_missing")
    if scope_captured and (not data_row or data_row[1] not in {"success", "running"}):
        issues.append("acg_scope_without_success")

    members_by_id = {str(row[0]): row for row in member_rows}
    request_rows = conn.execute(
        "SELECT id,username,username_key,status FROM member_requests"
    ).fetchall()
    requests_by_id = {str(row[0]): row for row in request_rows}
    account_ids = {
        str(row[0]) for row in conn.execute(
            "SELECT id FROM docs WHERE collection='accounts'"
        ).fetchall()
    }

    # The ACG data migration canonicalizes every captured identity key.
    # Refuse to make an
    # already ambiguous active identity namespace look migrated: members own
    # their key permanently, while only pending requests reserve a username.
    member_ids_by_key = {}
    for row in member_rows:
        key = canonical_username(row[1])
        if key:
            member_ids_by_key.setdefault(key, []).append(str(row[0]))
    request_ids_by_key = {}
    for row in request_rows:
        if str(row[3]) != "pending":
            continue
        key = canonical_username(row[1])
        if key:
            request_ids_by_key.setdefault(key, []).append(str(row[0]))
    member_collision_keys = {
        key for key, row_ids in member_ids_by_key.items() if len(row_ids) > 1
    }
    request_collision_keys = {
        key for key, row_ids in request_ids_by_key.items() if len(row_ids) > 1
    }
    cross_identity_collision_keys = (
        set(member_ids_by_key) & set(request_ids_by_key)
    )
    if member_collision_keys:
        issues.append("member_canonical_username_conflict")
    if request_collision_keys:
        issues.append("request_canonical_username_conflict")
    if cross_identity_collision_keys:
        issues.append("cross_identity_canonical_username_conflict")

    # Supplier relationships have no foreign keys in the legacy database.
    # Validate them before scope capture so INSERT OR IGNORE cannot hide a
    # missing/wrong parent, child or platform-account reference.
    supplier_parent_roles = {"supplier", "supplier_parent"}
    supplier_child_parent_orphans = 0
    for row in member_rows:
        if str(row[3]) != "supplier_child":
            continue
        parent_id = str(row[4] or "")
        parent = members_by_id.get(parent_id)
        if (
            not parent
            or str(parent[3]) not in supplier_parent_roles
            or bool(parent[4])
        ):
            supplier_child_parent_orphans += 1

    supplier_binding_orphans = 0
    for parent_id, child_id, account_id in conn.execute(
        "SELECT parent_id,child_id,account_id FROM supplier_account_bindings"
    ).fetchall():
        parent_id = str(parent_id or "")
        child_id = str(child_id or "")
        account_id = str(account_id or "")
        parent = members_by_id.get(parent_id)
        child = members_by_id.get(child_id)
        if (
            not parent
            or str(parent[3]) not in supplier_parent_roles
            or bool(parent[4])
            or not child
            or str(child[3]) != "supplier_child"
            or str(child[4] or "") != parent_id
            or account_id not in account_ids
        ):
            supplier_binding_orphans += 1
    if supplier_child_parent_orphans:
        issues.append("supplier_child_parent_orphan")
    if supplier_binding_orphans:
        issues.append("supplier_account_binding_orphan")

    if scope_captured:
        scoped = {}
        for kind, resource_id, target_role in scope_rows:
            scoped.setdefault(str(kind), []).append((str(resource_id), str(target_role or "")))
        member_scope = scoped.get("member", [])
        supplier_scope = [item[0] for item in scoped.get("supplier", [])]
        account_scope = [item[0] for item in scoped.get("account", [])]
        identity_member_scope = [item[0] for item in scoped.get("identity_member", [])]
        identity_request_scope = [item[0] for item in scoped.get("identity_request", [])]
    else:
        member_scope = []
        supplier_scope = []
        for row in member_rows:
            member_id, _username, _username_key, role, parent_id, _created_at = row
            member_id = str(member_id)
            if role in {"admin", "editor"}:
                target_role = (
                    "owner" if member_id == owner_id
                    else "admin" if role == "admin"
                    else "creator"
                )
                member_scope.append((member_id, target_role))
            if role in {"supplier_parent", "supplier"} and not parent_id:
                supplier_scope.append(member_id)
        account_scope = sorted(account_ids)
        identity_member_scope = sorted(members_by_id)
        identity_request_scope = sorted(requests_by_id)

    missing_scope_records = 0
    external_conflicts = 0
    member_inserts = 0
    member_updates = 0
    for member_id, target_role in member_scope:
        if member_id not in members_by_id:
            missing_scope_records += 1
            continue
        binding = conn.execute(
            "SELECT team_id,team_role,status FROM team_members WHERE member_id=?",
            (member_id,),
        ).fetchone()
        if binding and str(binding[0]) != INTERNAL_TEAM_ID:
            external_conflicts += 1
        elif not binding:
            member_inserts += 1
        elif str(binding[1]) != target_role or str(binding[2]) != "active":
            member_updates += 1

    supplier_inserts = 0
    legacy_supplier_roles = 0
    for supplier_id in supplier_scope:
        row = members_by_id.get(supplier_id)
        if not row:
            missing_scope_records += 1
            continue
        if str(row[3]) == "supplier":
            legacy_supplier_roles += 1
        binding = conn.execute(
            "SELECT team_id FROM team_suppliers WHERE supplier_parent_id=?",
            (supplier_id,),
        ).fetchone()
        if binding and str(binding[0]) != INTERNAL_TEAM_ID:
            external_conflicts += 1
        elif not binding:
            supplier_inserts += 1

    account_inserts = 0
    for account_id in account_scope:
        if account_id not in account_ids:
            missing_scope_records += 1
            continue
        binding = conn.execute(
            "SELECT team_id FROM team_accounts WHERE account_id=?",
            (account_id,),
        ).fetchone()
        if binding and str(binding[0]) != INTERNAL_TEAM_ID:
            external_conflicts += 1
        elif not binding:
            account_inserts += 1

    member_key_updates = sum(
        1 for member_id in identity_member_scope
        if member_id in members_by_id
        and str(members_by_id[member_id][2] or "")
        != canonical_username(members_by_id[member_id][1])
    )
    request_key_updates = sum(
        1 for request_id in identity_request_scope
        if request_id in requests_by_id
        and str(requests_by_id[request_id][2] or "")
        != canonical_username(requests_by_id[request_id][1])
    )
    missing_scope_records += sum(
        1 for member_id in identity_member_scope if member_id not in members_by_id
    )
    missing_scope_records += sum(
        1 for request_id in identity_request_scope if request_id not in requests_by_id
    )
    if missing_scope_records:
        issues.append("captured_resource_missing")
    if external_conflicts:
        issues.append("external_team_binding_conflict")

    counts = {
        "membersCaptured": len(member_scope),
        "memberMappingsPending": member_inserts,
        "memberRoleRepairsPending": member_updates,
        "suppliersCaptured": len(supplier_scope),
        "supplierMappingsPending": supplier_inserts,
        "legacySupplierRolesPending": legacy_supplier_roles,
        "accountsCaptured": len(account_scope),
        "accountMappingsPending": account_inserts,
        "memberUsernameKeysPending": member_key_updates,
        "requestUsernameKeysPending": request_key_updates,
        "memberCanonicalCollisionKeys": len(member_collision_keys),
        "memberCanonicalCollisionRows": sum(
            len(member_ids_by_key[key]) for key in member_collision_keys
        ),
        "requestCanonicalCollisionKeys": len(request_collision_keys),
        "requestCanonicalCollisionRows": sum(
            len(request_ids_by_key[key]) for key in request_collision_keys
        ),
        "crossIdentityCanonicalCollisionKeys": len(cross_identity_collision_keys),
        "supplierChildParentOrphans": supplier_child_parent_orphans,
        "supplierAccountBindingOrphans": supplier_binding_orphans,
        "externalBindingConflicts": external_conflicts,
        "missingCapturedRecords": missing_scope_records,
    }
    plan = {
        "ownerId": owner_id,
        "memberScope": member_scope,
        "supplierScope": supplier_scope,
        "accountScope": account_scope,
        "identityMemberScope": identity_member_scope,
        "identityRequestScope": identity_request_scope,
        "membersById": members_by_id,
        "requestsById": requests_by_id,
        "dataMigrationStatus": str(data_row[1]) if data_row else "pending",
    }
    summary = {
        "ok": not issues,
        "scopeCaptured": scope_captured,
        "schemaMigrationVersion": SCHEMA_MIGRATION_VERSION if schema_row else None,
        "dataMigrationVersion": (
            ACG_DATA_MIGRATION_VERSION if data_row and data_row[1] == "success" else None
        ),
        "dataMigrationStatus": str(data_row[1]) if data_row else "pending",
        "issues": sorted(set(issues)),
        "counts": counts,
        "totals": _acg_record_totals_locked(conn),
    }
    return summary, plan


def acg_internal_team_migration_preflight(
    *, expected_identity, owner_username, team_id, expected_schema_version,
):
    """Read-only ACG migration dry-run with no account names or resource IDs."""

    if int(expected_schema_version or 0) != SCHEMA_MIGRATION_VERSION:
        raise StoreNotReadyError("schema migration version confirmation mismatch")
    if not DB_PATH.is_file():
        raise StoreNotReadyError("migration target database must already exist")
    actual_identity = _database_identity(DB_PATH)
    if not hmac.compare_digest(str(expected_identity or ""), actual_identity):
        raise StoreNotReadyError("migration target database identity mismatch")
    conn = _connect(read_only=True)
    try:
        if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
            raise StoreNotReadyError("migration target failed SQLite quick_check")
        conn.execute("BEGIN")
        summary, _plan = _acg_plan_locked(conn, owner_username, team_id)
        conn.rollback()
        return {
            **summary,
            "dryRun": True,
            "databaseIdentity": actual_identity,
        }
    finally:
        conn.close()


def _record_failed_acg_migration(conn, error_name):
    now = int(time.time() * 1000)
    existing = _acg_data_migration_row_locked(conn)
    if existing and existing[0] != ACG_DATA_MIGRATION_CHECKSUM:
        return
    conn.execute(
        "INSERT OR REPLACE INTO schema_migrations("
        "version,name,checksum,app_version,started_at,finished_at,status,summary"
        ") VALUES(?,?,?,?,?,?,?,?)",
        (
            ACG_DATA_MIGRATION_VERSION,
            ACG_DATA_MIGRATION_NAME,
            ACG_DATA_MIGRATION_CHECKSUM,
            runtime_config.release_id() or "unidentified",
            now,
            now,
            "failed",
            json.dumps({"error": str(error_name or "migration_error")}, ensure_ascii=False),
        ),
    )


def apply_acg_internal_team_migration(
    *, expected_identity, owner_username, team_id, expected_schema_version,
    backup_binding=None,
):
    """Map the frozen legacy production scope to ACG without rewriting content."""

    global _initialized
    if runtime_config.is_read_only():
        raise StoreNotReadyError("read-only runtime cannot apply migrations")
    if runtime_config.runtime_mode() == "invalid":
        raise StoreNotReadyError("invalid ACG_RUNTIME_MODE")
    if str(os.getenv("ACG_ALLOW_ACG_TEAM_MIGRATION", "")).strip() != "1":
        raise StoreNotReadyError("ACG team migration authorization is required")
    if int(expected_schema_version or 0) != SCHEMA_MIGRATION_VERSION:
        raise StoreNotReadyError("schema migration version confirmation mismatch")
    if not DB_PATH.is_file():
        raise StoreNotReadyError("migration target database must already exist")
    actual_identity = _database_identity(DB_PATH)
    if not hmac.compare_digest(str(expected_identity or ""), actual_identity):
        raise StoreNotReadyError("migration target database identity mismatch")

    with _lock:
        conn = _connect_migration_target()
        migration_started = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            locked_identity = _database_identity(DB_PATH)
            if not hmac.compare_digest(
                str(expected_identity or ""), locked_identity,
            ):
                raise StoreNotReadyError("migration target database identity mismatch")
            if runtime_config.is_production():
                _verify_migration_backup_binding_locked(conn, backup_binding)
            if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
                raise StoreNotReadyError("migration target failed SQLite quick_check")
            summary, plan = _acg_plan_locked(conn, owner_username, team_id)
            if not summary["ok"]:
                raise StoreNotReadyError(
                    "ACG migration preflight failed: " + ",".join(summary["issues"])
                )
            if plan["dataMigrationStatus"] == "success":
                conn.rollback()
                return {
                    **summary,
                    "applied": False,
                    "dryRun": False,
                    "databaseIdentity": actual_identity,
                }

            before_totals = _acg_record_totals_locked(conn)
            protected_before = _acg_protected_digests_locked(conn)
            now = int(time.time() * 1000)
            conn.execute(ACG_MIGRATION_SCOPE_SCHEMA)
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations("
                "version,name,checksum,app_version,started_at,finished_at,status,summary"
                ") VALUES(?,?,?,?,?,NULL,'running','{}')",
                (
                    ACG_DATA_MIGRATION_VERSION,
                    ACG_DATA_MIGRATION_NAME,
                    ACG_DATA_MIGRATION_CHECKSUM,
                    runtime_config.release_id() or "unidentified",
                    now,
                ),
            )
            migration_started = True

            scope_rows = []
            scope_rows.extend(
                ("member", resource_id, target_role, now)
                for resource_id, target_role in plan["memberScope"]
            )
            scope_rows.extend(
                ("supplier", resource_id, "", now)
                for resource_id in plan["supplierScope"]
            )
            scope_rows.extend(
                ("account", resource_id, "", now)
                for resource_id in plan["accountScope"]
            )
            scope_rows.extend(
                ("identity_member", resource_id, "", now)
                for resource_id in plan["identityMemberScope"]
            )
            scope_rows.extend(
                ("identity_request", resource_id, "", now)
                for resource_id in plan["identityRequestScope"]
            )
            conn.executemany(
                "INSERT INTO acg_internal_migration_scope("
                "resource_kind,resource_id,target_role,captured_at) VALUES(?,?,?,?)",
                scope_rows,
            )

            if not conn.execute(
                "SELECT 1 FROM teams WHERE id=?", (INTERNAL_TEAM_ID,)
            ).fetchone():
                conn.execute(
                    "INSERT INTO teams("
                    "id,name,slug,kind,status,plan,quota_mode,created_at,created_by"
                    ") VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        INTERNAL_TEAM_ID, INTERNAL_TEAM_NAME, "acg-marketing",
                        "internal", "active", "team-pro", "unlimited", now,
                        plan["ownerId"],
                    ),
                )

            for member_id in plan["identityMemberScope"]:
                row = plan["membersById"][member_id]
                conn.execute(
                    "UPDATE members SET username_key=? WHERE id=?",
                    (canonical_username(row[1]), member_id),
                )
            for request_id in plan["identityRequestScope"]:
                row = plan["requestsById"][request_id]
                conn.execute(
                    "UPDATE member_requests SET username_key=? WHERE id=?",
                    (canonical_username(row[1]), request_id),
                )
            for supplier_id in plan["supplierScope"]:
                if str(plan["membersById"][supplier_id][3]) == "supplier":
                    conn.execute(
                        "UPDATE members SET role='supplier_parent' "
                        "WHERE id=? AND role='supplier' AND parent_id IS NULL",
                        (supplier_id,),
                    )

            for member_id, target_role in plan["memberScope"]:
                conn.execute(
                    "INSERT OR IGNORE INTO team_members("
                    "team_id,member_id,team_role,status,joined_at,added_by"
                    ") VALUES(?,?,?,?,?,?)",
                    (
                        INTERNAL_TEAM_ID, member_id, target_role, "active",
                        int(plan["membersById"][member_id][5] or now), plan["ownerId"],
                    ),
                )
                conn.execute(
                    "UPDATE team_members SET team_role=?,status='active' "
                    "WHERE team_id=? AND member_id=?",
                    (target_role, INTERNAL_TEAM_ID, member_id),
                )
            for supplier_id in plan["supplierScope"]:
                conn.execute(
                    "INSERT OR IGNORE INTO team_suppliers("
                    "team_id,supplier_parent_id,created_at,added_by"
                    ") VALUES(?,?,?,?)",
                    (INTERNAL_TEAM_ID, supplier_id, now, plan["ownerId"]),
                )
            for account_id in plan["accountScope"]:
                conn.execute(
                    "INSERT OR IGNORE INTO team_accounts("
                    "team_id,account_id,created_at,added_by"
                    ") VALUES(?,?,?,?)",
                    (INTERNAL_TEAM_ID, account_id, now, plan["ownerId"]),
                )

            conn.execute(
                "INSERT OR REPLACE INTO meta(k,v) VALUES("
                "'internal_team_members_migrated_v1',?)",
                (str(now),),
            )
            conn.execute(
                "INSERT OR REPLACE INTO meta(k,v) VALUES("
                "'internal_team_resources_migrated_v1',?)",
                (str(now),),
            )
            protected_after = _acg_protected_digests_locked(conn)
            if protected_after != protected_before:
                raise StoreNotReadyError("protected identity or business records changed")
            after_totals = _acg_record_totals_locked(conn)
            if any(after_totals[key] < before_totals[key] for key in before_totals):
                raise StoreNotReadyError("record totals declined during ACG migration")

            audit_summary = {
                "scope": {
                    "members": len(plan["memberScope"]),
                    "suppliers": len(plan["supplierScope"]),
                    "accounts": len(plan["accountScope"]),
                    "identityMembers": len(plan["identityMemberScope"]),
                    "identityRequests": len(plan["identityRequestScope"]),
                },
                "before": before_totals,
                "after": after_totals,
            }
            conn.execute(
                "UPDATE schema_migrations SET finished_at=?,status='success',summary=? "
                "WHERE version=?",
                (
                    int(time.time() * 1000),
                    json.dumps(audit_summary, ensure_ascii=False, sort_keys=True),
                    ACG_DATA_MIGRATION_VERSION,
                ),
            )
            conn.commit()
            _initialized = False
        except Exception as exc:
            conn.rollback()
            if migration_started:
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    _record_failed_acg_migration(conn, type(exc).__name__)
                    conn.commit()
                except Exception:
                    conn.rollback()
            raise
        finally:
            conn.close()

    result = acg_internal_team_migration_preflight(
        expected_identity=actual_identity,
        owner_username=owner_username,
        team_id=team_id,
        expected_schema_version=expected_schema_version,
    )
    return {**result, "applied": True, "dryRun": False}


_RESOURCE_SCOPE_MEMBER_FIELDS = ("ownerId", "byMemberId", "createdBy")
_RESOURCE_SCOPE_ACCOUNT_FIELDS = ("accountId",)
_RESOURCE_SCOPE_REFERENCE_FIELDS = {
    "jobs": (("productionId", "productions"),),
    "sessions": (("productionId", "productions"),),
    "batches": (("productionId", "productions"), ("productionIds", "productions")),
    "assets": (("productionId", "productions"), ("customProjectId", "customProjects")),
    "analyticsLinks": (("assetId", "assets"),),
    "metricSnapshots": (
        ("assetId", "assets"),
        ("analyticsLinkId", "analyticsLinks"),
        ("linkId", "analyticsLinks"),
        ("archivedLinkId", "analyticsLinks"),
    ),
    "insightReports": (("assetId", "assets"),),
    "creativeMemory": (("sourceReportId", "insightReports"),),
    "customOutputs": (("projectId", "customProjects"), ("customProjectId", "customProjects")),
    "customVideoJobs": (("projectId", "customProjects"), ("customProjectId", "customProjects")),
}
_RESOURCE_SCOPE_ACG_GLOBAL_COLLECTIONS = {"products", "publishTags"}


def _doc_resource_kind(collection):
    return f"doc:{str(collection or '')}"


def _resource_scope_data_row_locked(conn):
    return conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
    ).fetchone()


def _resource_scope_schema_ready_locked(conn):
    row = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    return row == (RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM, "success")


def _resource_scopes_enforced_locked(conn):
    if not _table_exists_locked(conn, "schema_migrations"):
        return False
    row = _resource_scope_data_row_locked(conn)
    return row == (RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM, "success")


def _member_resource_scope_locked(conn, identity):
    """Resolve one stable member id (or unique legacy username) to its tenant."""

    clean = str(identity or "").strip()
    if not clean:
        return None
    row = conn.execute(
        "SELECT id,username,role,parent_id FROM members WHERE id=?",
        (clean,),
    ).fetchone()
    if not row:
        matches = conn.execute(
            "SELECT id,username,role,parent_id FROM members WHERE username=?",
            (clean,),
        ).fetchall()
        if not matches:
            matches = [
                item for item in conn.execute(
                    "SELECT id,username,role,parent_id FROM members"
                ).fetchall()
                if canonical_username(item[1]) == canonical_username(clean)
            ]
        if len(matches) != 1:
            return None
        row = matches[0]
    member_id, _username, role, parent_id = map(
        lambda value: str(value or ""), row
    )
    membership = conn.execute(
        "SELECT team_id FROM team_members WHERE member_id=? AND status='active'",
        (member_id,),
    ).fetchall()
    team_ids = {str(item[0]) for item in membership}
    if role == "supplier_child" and parent_id:
        supplier_rows = conn.execute(
            "SELECT team_id FROM team_suppliers WHERE supplier_parent_id=?",
            (parent_id,),
        ).fetchall()
        team_ids.update(str(item[0]) for item in supplier_rows)
    elif role in {"supplier_parent", "supplier"}:
        supplier_rows = conn.execute(
            "SELECT team_id FROM team_suppliers WHERE supplier_parent_id=?",
            (member_id,),
        ).fetchall()
        team_ids.update(str(item[0]) for item in supplier_rows)
    if len(team_ids) == 1:
        return "team", next(iter(team_ids)), member_id
    if team_ids:
        return None
    if role == "user":
        return "member", member_id, member_id
    return None


def _account_resource_scope_locked(conn, account_id):
    clean = str(account_id or "").strip()
    if not clean:
        return None
    rows = conn.execute(
        "SELECT team_id FROM team_accounts WHERE account_id=?",
        (clean,),
    ).fetchall()
    team_ids = {str(item[0]) for item in rows}
    if len(team_ids) != 1:
        return None
    return "team", next(iter(team_ids)), ""


def _resource_values(value):
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item or "").strip()]
    clean = str(value or "").strip()
    return [clean] if clean else []


def _load_resource_scope_override_manifest(
    manifest_path, expected_sha256, database_state,
):
    """Load one exact operator-reviewed override file.

    The digest covers the file bytes, not a re-serialized JSON object.  Both
    preflight and apply therefore prove that they consumed the same artifact.
    Overrides are deliberately limited to unresolved legacy documents; target
    validation and exact coverage are performed while the database is locked.
    """

    raw_path = str(manifest_path or "").strip()
    expected = str(expected_sha256 or "").strip().lower()
    if not raw_path and not expected:
        return [], ""
    if not raw_path or not expected:
        raise StoreNotReadyError(
            "resource scope override manifest path and sha256 are both required"
        )
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise StoreNotReadyError("resource scope override manifest sha256 is invalid")
    path = Path(raw_path)
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise StoreNotReadyError("resource scope override manifest is unavailable") from exc
    if size <= 0 or size > RESOURCE_SCOPE_OVERRIDE_MANIFEST_MAX_BYTES:
        raise StoreNotReadyError("resource scope override manifest size is invalid")
    try:
        encoded = path.read_bytes()
    except OSError as exc:
        raise StoreNotReadyError("resource scope override manifest is unavailable") from exc
    actual = hashlib.sha256(encoded).hexdigest()
    if not hmac.compare_digest(expected, actual):
        raise StoreNotReadyError("resource scope override manifest sha256 mismatch")
    def strict_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"duplicate override manifest key: {key}")
            value[key] = item
        return value

    try:
        payload = json.loads(
            encoded.decode("utf-8"), object_pairs_hook=strict_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise StoreNotReadyError("resource scope override manifest JSON is invalid") from exc
    required_top = {
        "format", "databaseIdentity", "databasePathSha256",
        "databaseLogicalSha256", "schemaVersion", "userVersion",
        "backupManifestSha256", "resourceScopeSchemaVersion",
        "resourceScopeDataVersion", "entries",
    }
    if not isinstance(payload, dict) or set(payload) != required_top:
        raise StoreNotReadyError("resource scope override manifest fields are invalid")
    if payload.get("format") != RESOURCE_SCOPE_OVERRIDE_MANIFEST_FORMAT:
        raise StoreNotReadyError("resource scope override manifest format is invalid")
    state = database_state if isinstance(database_state, dict) else {}
    manifest_identity = str(payload.get("databaseIdentity") or "").strip().lower()
    if (
        not re.fullmatch(r"[0-9a-f]{16}", manifest_identity)
        or not hmac.compare_digest(
            manifest_identity,
            str(state.get("databaseIdentity") or "").strip().lower(),
        )
    ):
        raise StoreNotReadyError("resource scope override manifest database identity mismatch")
    for field, label in (
        ("databasePathSha256", "database path"),
        ("databaseLogicalSha256", "database logical state"),
        ("backupManifestSha256", "backup manifest"),
    ):
        manifest_value = str(payload.get(field) or "").strip().lower()
        state_value = str(state.get(field) or "").strip().lower()
        if (
            not re.fullmatch(r"[0-9a-f]{64}", manifest_value)
            or not hmac.compare_digest(manifest_value, state_value)
        ):
            raise StoreNotReadyError(
                f"resource scope override manifest {label} mismatch"
            )
    for field, label in (
        ("schemaVersion", "schema version"),
        ("userVersion", "user version"),
    ):
        if (
            type(payload.get(field)) is not int
            or payload.get(field) < 0
            or payload.get(field) != state.get(field)
        ):
            raise StoreNotReadyError(
                f"resource scope override manifest {label} mismatch"
            )
    if (
        type(payload.get("resourceScopeSchemaVersion")) is not int
        or payload.get("resourceScopeSchemaVersion")
        != RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
    ):
        raise StoreNotReadyError("resource scope override schema version mismatch")
    if (
        type(payload.get("resourceScopeDataVersion")) is not int
        or payload.get("resourceScopeDataVersion")
        != RESOURCE_SCOPE_DATA_MIGRATION_VERSION
    ):
        raise StoreNotReadyError("resource scope override data version mismatch")
    entries = payload.get("entries")
    if not isinstance(entries, list) or len(entries) > RESOURCE_SCOPE_OVERRIDE_MANIFEST_MAX_ENTRIES:
        raise StoreNotReadyError("resource scope override entries are invalid")
    required_entry = {
        "resourceKind", "resourceId", "scopeType", "scopeId", "reason", "evidence",
    }
    normalized = []
    seen = set()
    for raw in entries:
        if not isinstance(raw, dict) or set(raw) != required_entry:
            raise StoreNotReadyError("resource scope override entry fields are invalid")
        resource_kind = str(raw.get("resourceKind") or "").strip()
        resource_id = str(raw.get("resourceId") or "").strip()
        scope_type = str(raw.get("scopeType") or "").strip()
        scope_id = str(raw.get("scopeId") or "").strip()
        reason = str(raw.get("reason") or "").strip()
        evidence = str(raw.get("evidence") or "").strip()
        if (
            not resource_kind.startswith("doc:")
            or len(resource_kind) > 120
            or not resource_id
            or len(resource_id) > 240
            or scope_type not in {"team", "member"}
            or not scope_id
            or len(scope_id) > 240
            or not reason
            or len(reason) > 240
            or not evidence
            or len(evidence) > 1000
        ):
            raise StoreNotReadyError("resource scope override entry is invalid")
        key = (resource_kind, resource_id)
        if key in seen:
            raise StoreNotReadyError("resource scope override entry is duplicated")
        seen.add(key)
        normalized.append({
            "resourceKind": resource_kind,
            "resourceId": resource_id,
            "scopeType": scope_type,
            "scopeId": scope_id,
            "reason": reason,
            "evidence": evidence,
        })
    return normalized, actual


def _load_private_media_override_manifest(
    manifest_path,
    expected_sha256,
    database_state,
    expected_snapshot_manifest_sha256="",
    expected_snapshot_media_inventory_digest="",
):
    """Load one exact operator-reviewed media attribution manifest."""

    raw_path = str(manifest_path or "").strip()
    expected = str(expected_sha256 or "").strip().lower()
    expected_snapshot = str(expected_snapshot_manifest_sha256 or "").strip().lower()
    expected_snapshot_media = str(
        expected_snapshot_media_inventory_digest or ""
    ).strip().lower()
    if not raw_path and not expected:
        return [], "", "", "", "", ""
    if not raw_path or not expected:
        raise StoreNotReadyError(
            "private media override path and sha256 must be provided together"
        )
    if not expected_snapshot or not expected_snapshot_media:
        raise StoreNotReadyError(
            "private media override requires a verified runtime snapshot binding"
        )
    for label, value in (
        ("manifest", expected),
        ("snapshot manifest", expected_snapshot),
        ("snapshot media inventory", expected_snapshot_media),
    ):
        if not re.fullmatch(r"[0-9a-f]{64}", value):
            raise StoreNotReadyError(
                f"private media override {label} sha256 is invalid"
            )
    path = Path(raw_path)
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise StoreNotReadyError(
            "private media override manifest is unavailable"
        ) from exc
    if size <= 0 or size > PRIVATE_MEDIA_OVERRIDE_MANIFEST_MAX_BYTES:
        raise StoreNotReadyError("private media override manifest size is invalid")
    try:
        encoded = path.read_bytes()
    except OSError as exc:
        raise StoreNotReadyError(
            "private media override manifest is unavailable"
        ) from exc
    actual = hashlib.sha256(encoded).hexdigest()
    if not hmac.compare_digest(expected, actual):
        raise StoreNotReadyError("private media override manifest sha256 mismatch")
    def strict_object(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"duplicate override manifest key: {key}")
            value[key] = item
        return value

    try:
        payload = json.loads(
            encoded.decode("utf-8"), object_pairs_hook=strict_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise StoreNotReadyError(
            "private media override manifest JSON is invalid"
        ) from exc
    required_top = {
        "format", "databaseIdentity", "databasePathSha256",
        "databaseLogicalSha256", "schemaVersion", "userVersion",
        "backupManifestSha256",
        "privateMediaSchemaVersion",
        "privateMediaDataVersion", "inventoryDigest",
        "snapshotManifestSha256", "snapshotMediaInventoryDigest", "entries",
    }
    if not isinstance(payload, dict) or set(payload) != required_top:
        raise StoreNotReadyError("private media override manifest fields are invalid")
    if payload.get("format") != PRIVATE_MEDIA_OVERRIDE_MANIFEST_FORMAT:
        raise StoreNotReadyError("private media override manifest format is invalid")
    state = database_state if isinstance(database_state, dict) else {}
    manifest_identity = str(
        payload.get("databaseIdentity") or ""
    ).strip().lower()
    if (
        not re.fullmatch(r"[0-9a-f]{16}", manifest_identity)
        or not hmac.compare_digest(
            manifest_identity,
            str(state.get("databaseIdentity") or "").strip().lower(),
        )
    ):
        raise StoreNotReadyError(
            "private media override manifest database identity mismatch"
        )
    for field, label in (
        ("databasePathSha256", "database path"),
        ("databaseLogicalSha256", "database logical state"),
        ("backupManifestSha256", "backup manifest"),
    ):
        manifest_value = str(payload.get(field) or "").strip().lower()
        state_value = str(state.get(field) or "").strip().lower()
        if (
            not re.fullmatch(r"[0-9a-f]{64}", manifest_value)
            or not hmac.compare_digest(manifest_value, state_value)
        ):
            raise StoreNotReadyError(
                f"private media override manifest {label} mismatch"
            )
    for field, label in (
        ("schemaVersion", "schema version"),
        ("userVersion", "user version"),
    ):
        if (
            type(payload.get(field)) is not int
            or payload.get(field) < 0
            or payload.get(field) != state.get(field)
        ):
            raise StoreNotReadyError(
                f"private media override manifest {label} mismatch"
            )
    if (
        type(payload.get("privateMediaSchemaVersion")) is not int
        or payload.get("privateMediaSchemaVersion")
        != PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
    ):
        raise StoreNotReadyError("private media override schema version mismatch")
    if (
        type(payload.get("privateMediaDataVersion")) is not int
        or payload.get("privateMediaDataVersion")
        != PRIVATE_MEDIA_DATA_MIGRATION_VERSION
    ):
        raise StoreNotReadyError("private media override data version mismatch")
    inventory_digest = str(payload.get("inventoryDigest") or "").strip().lower()
    database_logical_digest = str(
        payload.get("databaseLogicalSha256") or ""
    ).strip().lower()
    snapshot_digest = str(payload.get("snapshotManifestSha256") or "").strip().lower()
    snapshot_media_digest = str(
        payload.get("snapshotMediaInventoryDigest") or ""
    ).strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", inventory_digest):
        raise StoreNotReadyError("private media override inventory digest is invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", database_logical_digest):
        raise StoreNotReadyError(
            "private media override database logical sha256 is invalid"
        )
    if not hmac.compare_digest(snapshot_digest, expected_snapshot):
        raise StoreNotReadyError(
            "private media override snapshot manifest sha256 mismatch"
        )
    if not hmac.compare_digest(snapshot_media_digest, expected_snapshot_media):
        raise StoreNotReadyError(
            "private media override snapshot media inventory digest mismatch"
        )
    entries = payload.get("entries")
    if (
        not isinstance(entries, list)
        or not entries
        or len(entries) > PRIVATE_MEDIA_OVERRIDE_MANIFEST_MAX_ENTRIES
    ):
        raise StoreNotReadyError("private media override entries are invalid")
    required_entry = {"mediaKind", "mediaKey", "ownerId", "reason", "evidence"}
    normalized = []
    seen = set()
    for raw in entries:
        if not isinstance(raw, dict) or set(raw) != required_entry:
            raise StoreNotReadyError(
                "private media override entry fields are invalid"
            )
        try:
            media_kind, media_key = _normalize_private_media_key(
                raw.get("mediaKind"), raw.get("mediaKey"),
            )
        except ValueError as exc:
            raise StoreNotReadyError(
                "private media override identity is invalid"
            ) from exc
        owner_id = str(raw.get("ownerId") or "").strip()
        reason = str(raw.get("reason") or "").strip()
        evidence = str(raw.get("evidence") or "").strip()
        if (
            not owner_id or len(owner_id) > 240
            or not reason or len(reason) > 240
            or not evidence or len(evidence) > 1000
        ):
            raise StoreNotReadyError("private media override entry is invalid")
        key = (media_kind, media_key)
        if key in seen:
            raise StoreNotReadyError("private media override entry is duplicated")
        seen.add(key)
        normalized.append({
            "mediaKind": media_kind,
            "mediaKey": media_key,
            "ownerId": owner_id,
            "reason": reason,
            "evidence": evidence,
        })
    return (
        normalized,
        actual,
        inventory_digest,
        snapshot_digest,
        snapshot_media_digest,
        database_logical_digest,
    )


def _resource_scope_plan_locked(
    conn, *, override_entries=None, override_manifest_sha256="",
):
    issues = []
    schema_row = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,),
    ).fetchone()
    if schema_row != (RESOURCE_SCOPE_SCHEMA_MIGRATION_CHECKSUM, "success"):
        issues.append("resource_scope_schema_not_ready")
    acg_row = conn.execute(
        "SELECT checksum,status FROM schema_migrations WHERE version=?",
        (ACG_DATA_MIGRATION_VERSION,),
    ).fetchone()
    if acg_row != (ACG_DATA_MIGRATION_CHECKSUM, "success"):
        issues.append("acg_migration_not_ready")
    dirty_other = int(conn.execute(
        "SELECT COUNT(*) FROM schema_migrations WHERE status<>'success' AND version<>?",
        (RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
    ).fetchone()[0] or 0)
    if dirty_other:
        issues.append("other_dirty_migrations")

    data_row = _resource_scope_data_row_locked(conn)
    if data_row and data_row[0] != RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM:
        issues.append("resource_scope_migration_checksum_mismatch")
    if data_row and data_row[1] == "running":
        issues.append("resource_scope_migration_running")

    docs = []
    for collection, resource_id, owner_id, raw in conn.execute(
        "SELECT collection,id,owner_id,data FROM docs ORDER BY collection,id"
    ).fetchall():
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            payload = None
        docs.append({
            "collection": str(collection),
            "resourceId": str(resource_id),
            "ownerId": str(owner_id or ""),
            "payload": payload,
        })
    doc_keys = {
        (item["collection"], item["resourceId"]) for item in docs
    }
    existing_rows = conn.execute(
        "SELECT resource_kind,resource_id,scope_type,scope_id,owner_id,provenance "
        "FROM resource_scopes ORDER BY resource_kind,resource_id"
    ).fetchall() if _table_exists_locked(conn, "resource_scopes") else []
    existing = {
        (str(kind), str(resource_id)): (
            str(scope_type), str(scope_id), str(owner_id or ""), str(provenance)
        )
        for kind, resource_id, scope_type, scope_id, owner_id, provenance in existing_rows
    }

    plan = {}
    invalid_json_keys = set()
    unresolved_keys = set()
    ambiguous_keys = set()
    missing_identity_refs = set()
    missing_account_refs = set()
    dangling_reference_refs = set()
    candidate_scopes = {}
    orphan_scopes = 0
    invalid_scope_targets = 0
    warnings = []
    override_entries = list(override_entries or [])
    override_by_key = {
        (entry["resourceKind"], entry["resourceId"]): entry
        for entry in override_entries
    }

    if data_row and data_row[1] == "success":
        for item in docs:
            key = (_doc_resource_kind(item["collection"]), item["resourceId"])
            scope = existing.get(key)
            if not scope:
                unresolved_keys.add(key)
                continue
            scope_type, scope_id, stored_owner, provenance = scope
            if scope_type == "team":
                target = conn.execute(
                    "SELECT 1 FROM teams WHERE id=? AND status='active'", (scope_id,)
                ).fetchone()
            else:
                member_scope = _member_resource_scope_locked(conn, scope_id)
                target = bool(
                    member_scope and member_scope[:2] == ("member", scope_id)
                )
            if not target:
                invalid_scope_targets += 1
            payload = item["payload"]
            if not isinstance(payload, dict):
                invalid_json_keys.add(key)
                continue
            expected_scope = (scope_type, scope_id)
            identities = [item["ownerId"]]
            identities.extend(
                _resource_values(payload.get(field))
                for field in _RESOURCE_SCOPE_MEMBER_FIELDS
            )
            if stored_owner:
                identities.append(stored_owner)
            flattened_identities = []
            for value in identities:
                flattened_identities.extend(
                    value if isinstance(value, list) else _resource_values(value)
                )
            for identity in dict.fromkeys(flattened_identities):
                resolved = _member_resource_scope_locked(conn, identity)
                if not resolved:
                    missing_identity_refs.add((key, identity))
                elif resolved[:2] != expected_scope:
                    issues.append("resource_scope_member_drift")

            account_values = []
            if item["collection"] == "accounts":
                account_values.append(item["resourceId"])
            for field in _RESOURCE_SCOPE_ACCOUNT_FIELDS:
                account_values.extend(_resource_values(payload.get(field)))
            for account_id in dict.fromkeys(account_values):
                resolved = _account_resource_scope_locked(conn, account_id)
                if not resolved:
                    missing_account_refs.add((key, account_id))
                elif resolved[:2] != expected_scope:
                    issues.append("resource_scope_account_drift")

            for field, target_collection in _RESOURCE_SCOPE_REFERENCE_FIELDS.get(
                item["collection"], ()
            ):
                for target_id in _resource_values(payload.get(field)):
                    target_scope = existing.get(
                        (_doc_resource_kind(target_collection), target_id)
                    )
                    if not target_scope:
                        dangling_reference_refs.add(
                            (key, field, target_collection, target_id)
                        )
                        if (target_collection, target_id) in doc_keys:
                            issues.append("resource_scope_reference_registry_missing")
                    elif target_scope[:2] != expected_scope:
                        issues.append("resource_scope_reference_drift")
            plan[key] = (*scope,)
        for kind, resource_id in existing:
            if not kind.startswith("doc:"):
                continue
            if (kind[4:], resource_id) not in doc_keys:
                orphan_scopes += 1
        for key, entry in override_by_key.items():
            stored = existing.get(key)
            if not stored or (stored[0], stored[1]) != (
                entry["scopeType"], entry["scopeId"],
            ):
                issues.append("resource_scope_override_drift")
    else:
        if existing_rows:
            issues.append("resource_scope_registry_not_empty")
        pending = list(docs)
        for _pass in range(max(2, len(COLLECTIONS) + 2)):
            next_pending = []
            progressed = False
            for item in pending:
                collection = item["collection"]
                resource_id = item["resourceId"]
                payload = item["payload"]
                key = (_doc_resource_kind(collection), resource_id)
                if not isinstance(payload, dict):
                    invalid_json_keys.add(key)
                    next_pending.append(item)
                    continue
                candidates = set()
                owner_id = item["ownerId"]
                identities = [owner_id]
                identities.extend(
                    _resource_values(payload.get(field))
                    for field in _RESOURCE_SCOPE_MEMBER_FIELDS
                )
                flattened_identities = []
                for value in identities:
                    flattened_identities.extend(
                        value if isinstance(value, list) else _resource_values(value)
                    )
                for identity in dict.fromkeys(flattened_identities):
                    resolved = _member_resource_scope_locked(conn, identity)
                    if resolved:
                        candidates.add((resolved[0], resolved[1]))
                    else:
                        missing_identity_refs.add((key, identity))

                account_values = []
                if collection == "accounts":
                    account_values.append(resource_id)
                for field in _RESOURCE_SCOPE_ACCOUNT_FIELDS:
                    account_values.extend(_resource_values(payload.get(field)))
                for account_id in dict.fromkeys(account_values):
                    resolved = _account_resource_scope_locked(conn, account_id)
                    if resolved:
                        candidates.add((resolved[0], resolved[1]))
                    else:
                        missing_account_refs.add((key, account_id))

                waiting_reference = False
                for field, target_collection in _RESOURCE_SCOPE_REFERENCE_FIELDS.get(
                    collection, ()
                ):
                    for target_id in _resource_values(payload.get(field)):
                        target_key = (_doc_resource_kind(target_collection), target_id)
                        if (target_collection, target_id) not in doc_keys:
                            dangling_reference_refs.add(
                                (key, field, target_collection, target_id)
                            )
                            continue
                        target_scope = plan.get(target_key)
                        if not target_scope:
                            waiting_reference = True
                            continue
                        candidates.add((target_scope[0], target_scope[1]))

                if not candidates and collection in _RESOURCE_SCOPE_ACG_GLOBAL_COLLECTIONS:
                    candidates.add(("team", INTERNAL_TEAM_ID))
                candidate_scopes[key] = set(candidates)
                if len(candidates) > 1:
                    ambiguous_keys.add(key)
                    continue
                # Existing references are authoritative even when their target
                # sorts later in ``docs``.  Do not freeze an owner-only answer
                # before every extant reference has resolved, otherwise a later
                # cross-tenant target could be silently ignored.
                if waiting_reference:
                    next_pending.append(item)
                    continue
                if len(candidates) == 1:
                    scope_type, scope_id = next(iter(candidates))
                    plan[key] = (
                        scope_type,
                        scope_id,
                        owner_id,
                        "v140-deterministic-owner-account-reference",
                    )
                    progressed = True
                    continue
                next_pending.append(item)
            pending = next_pending
            if not progressed:
                break
        unresolved_keys = {
            (_doc_resource_kind(item["collection"]), item["resourceId"])
            for item in pending
        }

        # Overrides may resolve only documents with no trustworthy candidate at
        # all.  Ambiguous resources, invalid JSON and records waiting on an
        # unresolved extant reference remain hard failures.
        eligible_override_keys = {
            key for key in unresolved_keys
            if not candidate_scopes.get(key) and key not in invalid_json_keys
        }
        supplied_override_keys = set(override_by_key)
        if eligible_override_keys - supplied_override_keys:
            issues.append("resource_scope_override_missing")
        if supplied_override_keys - eligible_override_keys:
            issues.append("resource_scope_override_extra")
        if supplied_override_keys == eligible_override_keys:
            docs_by_key = {
                (_doc_resource_kind(item["collection"]), item["resourceId"]): item
                for item in docs
            }
            for key in sorted(supplied_override_keys):
                entry = override_by_key[key]
                scope_type = entry["scopeType"]
                scope_id = entry["scopeId"]
                if scope_type == "team":
                    target_valid = bool(conn.execute(
                        "SELECT 1 FROM teams WHERE id=? AND status='active'",
                        (scope_id,),
                    ).fetchone())
                else:
                    target = _member_resource_scope_locked(conn, scope_id)
                    target_valid = bool(
                        target and target[:2] == ("member", scope_id)
                    )
                if not target_valid:
                    issues.append("resource_scope_override_target_invalid")
                    continue
                item = docs_by_key[key]
                plan[key] = (
                    scope_type,
                    scope_id,
                    item["ownerId"],
                    "v140-explicit-override:" + override_manifest_sha256[:16],
                )
                unresolved_keys.discard(key)

    resolved_keys = set(plan)
    blocking_keys = unresolved_keys | ambiguous_keys | invalid_json_keys
    stale_identity = {entry for entry in missing_identity_refs if entry[0] in resolved_keys}
    stale_account = {entry for entry in missing_account_refs if entry[0] in resolved_keys}
    stale_reference = {
        entry for entry in dangling_reference_refs if entry[0] in resolved_keys
    }
    if stale_identity:
        warnings.append("resource_owner_identity_stale")
    if stale_account:
        warnings.append("resource_account_mapping_stale")
    if stale_reference:
        warnings.append("resource_reference_stale")

    if invalid_json_keys:
        issues.append("resource_payload_invalid_json")
    if unresolved_keys:
        issues.append("resource_scope_unresolved")
    if ambiguous_keys:
        issues.append("resource_scope_ambiguous")
    if any(entry[0] in blocking_keys for entry in missing_identity_refs):
        issues.append("resource_owner_identity_missing")
    if any(entry[0] in blocking_keys for entry in missing_account_refs):
        issues.append("resource_account_mapping_missing")
    if any(entry[0] in blocking_keys for entry in dangling_reference_refs):
        issues.append("resource_reference_missing")
    if orphan_scopes:
        issues.append("resource_scope_orphan")
    if invalid_scope_targets:
        issues.append("resource_scope_target_missing")
    if len(plan) != len(docs):
        issues.append("resource_scope_coverage_incomplete")

    counts = {
        "documents": len(docs),
        "scoped": len(plan),
        "unresolved": len(unresolved_keys),
        "ambiguous": len(ambiguous_keys),
        "invalidJson": len(invalid_json_keys),
        "missingOwnerIdentities": len(missing_identity_refs),
        "missingAccountMappings": len(missing_account_refs),
        "danglingReferences": len(dangling_reference_refs),
        "staleOwnerIdentities": len(stale_identity),
        "staleAccountMappings": len(stale_account),
        "staleReferences": len(stale_reference),
        "overrideEntries": len(override_entries),
        "orphanScopes": orphan_scopes,
        "invalidScopeTargets": invalid_scope_targets,
    }
    return {
        "ok": not issues,
        "dataMigrationStatus": str(data_row[1]) if data_row else "pending",
        "schemaMigrationVersion": (
            RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION if schema_row else None
        ),
        "dataMigrationVersion": (
            RESOURCE_SCOPE_DATA_MIGRATION_VERSION
            if data_row and data_row[1] == "success" else None
        ),
        "issues": sorted(set(issues)),
        "warnings": sorted(set(warnings)),
        "overrideManifestSha256": str(override_manifest_sha256 or ""),
        "unresolvedResources": [
            {"resourceKind": kind, "resourceId": resource_id}
            for kind, resource_id in sorted(unresolved_keys)
        ],
        "ambiguousResources": [
            {"resourceKind": kind, "resourceId": resource_id}
            for kind, resource_id in sorted(ambiguous_keys)
        ],
        "counts": counts,
    }, plan


def resource_scope_migration_preflight(
    *, expected_identity, expected_schema_version, override_manifest_path="",
    expected_override_manifest_sha256="", backup_binding=None,
):
    if int(expected_schema_version or 0) != RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION:
        raise StoreNotReadyError("resource scope schema version confirmation mismatch")
    if not DB_PATH.is_file():
        raise StoreNotReadyError("migration target database must already exist")
    actual_identity = _database_identity(DB_PATH)
    if not hmac.compare_digest(str(expected_identity or ""), actual_identity):
        raise StoreNotReadyError("migration target database identity mismatch")
    conn = _connect(read_only=True)
    try:
        if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
            raise StoreNotReadyError("migration target failed SQLite quick_check")
        conn.execute("BEGIN")
        override_requested = bool(
            str(override_manifest_path or "").strip()
            or str(expected_override_manifest_sha256 or "").strip()
        )
        if backup_binding is not None or override_requested:
            database_state = _verify_migration_backup_binding_locked(
                conn, backup_binding,
            )
        else:
            database_state = _database_review_state_locked(conn)
        override_entries, override_digest = _load_resource_scope_override_manifest(
            override_manifest_path,
            expected_override_manifest_sha256,
            database_state,
        )
        summary, _plan = _resource_scope_plan_locked(
            conn,
            override_entries=override_entries,
            override_manifest_sha256=override_digest,
        )
        conn.rollback()
        return {**summary, **database_state, "dryRun": True}
    finally:
        conn.close()


def _record_failed_resource_scope_migration(conn, error_name):
    now = int(time.time() * 1000)
    existing = _resource_scope_data_row_locked(conn)
    if existing and existing[0] != RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM:
        return
    conn.execute(
        "INSERT OR REPLACE INTO schema_migrations("
        "version,name,checksum,app_version,started_at,finished_at,status,summary"
        ") VALUES(?,?,?,?,?,?,?,?)",
        (
            RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
            RESOURCE_SCOPE_DATA_MIGRATION_NAME,
            RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
            runtime_config.release_id() or "unidentified",
            now,
            now,
            "failed",
            json.dumps({"error": str(error_name or "migration_error")}),
        ),
    )


def apply_resource_scope_migration(
    *, expected_identity, expected_schema_version, backup_binding=None,
    override_manifest_path="", expected_override_manifest_sha256="",
):
    """Freeze deterministic tenant ownership without rewriting legacy documents."""

    global _initialized
    if runtime_config.is_read_only():
        raise StoreNotReadyError("read-only runtime cannot apply migrations")
    if runtime_config.runtime_mode() == "invalid":
        raise StoreNotReadyError("invalid ACG_RUNTIME_MODE")
    if str(os.getenv("ACG_ALLOW_RESOURCE_SCOPE_MIGRATION", "")).strip() != "1":
        raise StoreNotReadyError("resource scope migration authorization is required")
    if int(expected_schema_version or 0) != RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION:
        raise StoreNotReadyError("resource scope schema version confirmation mismatch")
    if not DB_PATH.is_file():
        raise StoreNotReadyError("migration target database must already exist")
    actual_identity = _database_identity(DB_PATH)
    if not hmac.compare_digest(str(expected_identity or ""), actual_identity):
        raise StoreNotReadyError("migration target database identity mismatch")

    applied_override_digest = ""
    applied_override_entries = 0
    applied_override_state = {}
    with _lock:
        conn = _connect_migration_target()
        migration_started = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            locked_identity = _database_identity(DB_PATH)
            if not hmac.compare_digest(
                str(expected_identity or ""), locked_identity,
            ):
                raise StoreNotReadyError("migration target database identity mismatch")
            override_requested = bool(
                str(override_manifest_path or "").strip()
                or str(expected_override_manifest_sha256 or "").strip()
            )
            if (
                runtime_config.is_production()
                or backup_binding is not None
                or override_requested
            ):
                database_state = _verify_migration_backup_binding_locked(
                    conn, backup_binding,
                )
            else:
                database_state = _database_review_state_locked(conn)
            override_entries, override_digest = _load_resource_scope_override_manifest(
                override_manifest_path,
                expected_override_manifest_sha256,
                database_state,
            )
            if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
                raise StoreNotReadyError("migration target failed SQLite quick_check")
            summary, plan = _resource_scope_plan_locked(
                conn,
                override_entries=override_entries,
                override_manifest_sha256=override_digest,
            )
            if not summary["ok"]:
                raise StoreNotReadyError(
                    "resource scope migration preflight failed: "
                    + ",".join(summary["issues"])
                )
            if summary["dataMigrationStatus"] == "success":
                conn.rollback()
                return {
                    **summary,
                    "applied": False,
                    "dryRun": False,
                    "databaseIdentity": actual_identity,
                }
            protected_before = _acg_protected_digests_locked(conn)["docs"]
            now = int(time.time() * 1000)
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations("
                "version,name,checksum,app_version,started_at,finished_at,status,summary"
                ") VALUES(?,?,?,?,?,NULL,'running','{}')",
                (
                    RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                    RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                    RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                    runtime_config.release_id() or "unidentified",
                    now,
                ),
            )
            migration_started = True
            rows = [
                (kind, resource_id, *scope[:3], scope[3], now, now)
                for (kind, resource_id), scope in sorted(plan.items())
            ]
            conn.executemany(
                "INSERT INTO resource_scopes("
                "resource_kind,resource_id,scope_type,scope_id,owner_id,provenance,"
                "captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                rows,
            )
            protected_after = _acg_protected_digests_locked(conn)["docs"]
            if protected_after != protected_before:
                raise StoreNotReadyError("protected business documents changed")
            audit = {
                "counts": summary["counts"],
                "warnings": summary.get("warnings") or [],
                "overrideManifestSha256": summary.get("overrideManifestSha256") or "",
                "overrideEntries": int(
                    (summary.get("counts") or {}).get("overrideEntries") or 0
                ),
                "overrideDatabaseIdentity": (
                    database_state.get("databaseIdentity") if override_digest else ""
                ),
                "overrideDatabasePathSha256": (
                    database_state.get("databasePathSha256") if override_digest else ""
                ),
                "overrideDatabaseLogicalSha256": (
                    database_state.get("databaseLogicalSha256") if override_digest else ""
                ),
                "overrideSchemaVersion": (
                    database_state.get("schemaVersion") if override_digest else None
                ),
                "overrideUserVersion": (
                    database_state.get("userVersion") if override_digest else None
                ),
                "overrideBackupManifestSha256": (
                    database_state.get("backupManifestSha256") if override_digest else ""
                ),
            }
            conn.execute(
                "UPDATE schema_migrations SET finished_at=?,status='success',summary=? "
                "WHERE version=?",
                (
                    int(time.time() * 1000),
                    json.dumps(audit, ensure_ascii=False, sort_keys=True),
                    RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                ),
            )
            conn.commit()
            applied_override_digest = override_digest
            applied_override_entries = len(override_entries)
            applied_override_state = dict(database_state) if override_digest else {}
            _initialized = False
        except Exception as exc:
            conn.rollback()
            if migration_started:
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    _record_failed_resource_scope_migration(conn, type(exc).__name__)
                    conn.commit()
                except Exception:
                    conn.rollback()
            raise
        finally:
            conn.close()
    result = resource_scope_migration_preflight(
        expected_identity=actual_identity,
        expected_schema_version=expected_schema_version,
    )
    return {
        **result,
        "overrideManifestSha256": applied_override_digest,
        "appliedOverrideEntries": applied_override_entries,
        "appliedOverrideDatabaseState": applied_override_state,
        "applied": True,
        "dryRun": False,
    }


def _ensure_db():
    global _initialized
    if _initialized:
        return
    with _lock:
        if _initialized:
            return
        if runtime_config.runtime_mode() == "invalid":
            raise StoreNotReadyError("invalid ACG_RUNTIME_MODE")
        bootstrap_mode = runtime_config.db_bootstrap_mode()
        if runtime_config.is_read_only() or bootstrap_mode == "validate":
            status = database_readiness()
            if not status.get("ok"):
                raise StoreNotReadyError("database migration/readiness validation failed")
            _initialized = True
            return
        conn = _connect(read_only=False)
        try:
            _apply_schema_locked(conn)
            # Legacy local/test compatibility.  Production never reaches this
            # branch and therefore cannot seed, repair roles or rewrite a PIN
            # hash during normal startup.
            conn.execute("UPDATE members SET role='supplier_parent' WHERE role='supplier'")
            _ensure_username_keys_locked(conn)
            _seed_admin_locked(conn)
            _ensure_admin_alias_locked(conn)
            _ensure_supplier_parent_role_locked(conn)
            _ensure_username_keys_locked(conn)
            _ensure_internal_team_locked(conn)
            _record_schema_migration_locked(conn, summary={"schema": "expand", "mode": "local-auto"})
            conn.commit()
            _apply_model_usage_schema_locked(conn)
            _record_model_usage_schema_migration_locked(
                conn,
                summary={"schema": "model-usage-receipt-outbox", "mode": "local-auto"},
            )
            conn.commit()
            _apply_resource_scope_schema_locked(conn)
            _record_resource_scope_schema_migration_locked(
                conn,
                summary={"schema": "resource-scopes", "mode": "local-auto"},
            )
            conn.commit()
            _apply_private_media_schema_locked(conn)
            _record_private_media_schema_migration_locked(
                conn,
                summary={"schema": "private-media-registry", "mode": "local-auto"},
            )
            conn.commit()
            _apply_video_compose_schema_locked(conn)
            _record_video_compose_schema_migration_locked(
                conn,
                summary={"schema": "video-compose-idempotency", "mode": "local-auto"},
            )
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


# ---------- 私有媒体归属登记（URL/路径保持不变） ----------
PRIVATE_MEDIA_KINDS = frozenset({
    "upload", "composed", "canvas-blob", "video-output", "video-upload",
})


def _normalize_private_media_key(kind, value):
    media_kind = str(kind or "").strip().lower()
    if media_kind not in PRIVATE_MEDIA_KINDS:
        raise ValueError("invalid_private_media_kind")
    key = str(value or "").strip()
    if (
        not key
        or len(key) > 1200
        or "\\" in key
        or "\x00" in key
        or "%" in key
        or "?" in key
        or "#" in key
    ):
        raise ValueError("invalid_private_media_key")
    if media_kind == "canvas-blob":
        if not re.fullmatch(r"[a-f0-9]{64}", key):
            raise ValueError("invalid_private_media_key")
        return media_kind, key
    if media_kind in {"upload", "composed"}:
        if Path(key).name != key or key in {".", ".."}:
            raise ValueError("invalid_private_media_key")
        return media_kind, key
    if key.startswith("/"):
        raise ValueError("invalid_private_media_key")
    parts = key.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("invalid_private_media_key")
    return media_kind, "/".join(parts)


def _private_media_member_teams_locked(conn, member_id):
    return [
        str(row[0])
        for row in conn.execute(
            "SELECT team_id FROM team_members WHERE member_id=? AND status='active' "
            "ORDER BY team_id",
            (str(member_id or ""),),
        ).fetchall()
    ]


def _private_media_registration_team_locked(conn, owner_id, requested_team_id=""):
    teams = _private_media_member_teams_locked(conn, owner_id)
    requested = str(requested_team_id or "").strip()
    if requested:
        if requested not in teams:
            raise ValueError("private_media_team_mismatch")
        return requested
    if len(teams) > 1:
        raise ValueError("private_media_team_ambiguous")
    return teams[0] if teams else ""


def _private_media_row_public(row):
    if not row:
        return None
    return {
        "kind": str(row[0]),
        "key": str(row[1]),
        "ownerId": str(row[2]),
        "teamId": str(row[3] or ""),
        "provenanceKind": str(row[4]),
        "provenanceId": str(row[5]),
        "createdAt": int(row[6]),
        "updatedAt": int(row[7]),
    }


def _register_private_media_locked(
    conn,
    kind,
    key,
    owner_id,
    *,
    team_id="",
    provenance_kind,
    provenance_id,
    now=None,
):
    media_kind, media_key = _normalize_private_media_key(kind, key)
    owner = str(owner_id or "").strip()
    if not owner or not conn.execute(
        "SELECT 1 FROM members WHERE id=?", (owner,),
    ).fetchone():
        raise ValueError("private_media_owner_missing")
    provenance_type = str(provenance_kind or "").strip()[:80]
    provenance_key = str(provenance_id or "").strip()[:240]
    if not provenance_type or not provenance_key:
        raise ValueError("private_media_provenance_required")
    authoritative_team = _private_media_registration_team_locked(
        conn, owner, team_id,
    )
    existing_rows = conn.execute(
        "SELECT media_kind,media_key,owner_id,team_id,provenance_kind,"
        "provenance_id,created_at,updated_at FROM private_media_registry "
        "WHERE media_kind=? AND media_key=? ORDER BY owner_id",
        (media_kind, media_key),
    ).fetchall()
    for row in existing_rows:
        if str(row[2]) != owner and media_kind != "canvas-blob":
            raise ValueError("private_media_owner_conflict")
        if str(row[2]) == owner:
            if str(row[3] or "") != authoritative_team:
                raise ValueError("private_media_team_conflict")
            result = _private_media_row_public(row)
            result["created"] = False
            return result
    timestamp = int(now if now is not None else time.time() * 1000)
    conn.execute(
        "INSERT INTO private_media_registry("
        "media_kind,media_key,owner_id,team_id,provenance_kind,provenance_id,"
        "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        (
            media_kind, media_key, owner, authoritative_team,
            provenance_type, provenance_key, timestamp, timestamp,
        ),
    )
    row = conn.execute(
        "SELECT media_kind,media_key,owner_id,team_id,provenance_kind,"
        "provenance_id,created_at,updated_at FROM private_media_registry "
        "WHERE media_kind=? AND media_key=? AND owner_id=?",
        (media_kind, media_key, owner),
    ).fetchone()
    result = _private_media_row_public(row)
    result["created"] = True
    return result


def register_private_media(
    kind,
    key,
    owner_id,
    *,
    team_id="",
    provenance_kind,
    provenance_id,
):
    """Register one file before its stable direct URL is returned to a client."""

    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            result = _register_private_media_locked(
                conn,
                kind,
                key,
                owner_id,
                team_id=team_id,
                provenance_kind=provenance_kind,
                provenance_id=provenance_id,
            )
            conn.commit()
            return result
        finally:
            conn.close()


_VIDEO_COMPOSE_OPERATION_COLUMNS = (
    "owner_id,operation_key,production_id,request_fingerprint,state,claim_token,"
    "output_name,error,attempt,created_at,updated_at,completed_at"
)


def _video_compose_operation_public(row, *, claimed=False, reused=False):
    if not row:
        return None
    output_name = str(row[6] or "")
    return {
        "ownerId": str(row[0]),
        "operationKey": str(row[1]),
        "productionId": str(row[2] or ""),
        "requestFingerprint": str(row[3]),
        "state": str(row[4]),
        "claimToken": str(row[5] or "") if claimed else "",
        "outputName": output_name,
        "url": f"/api/video/composed/{output_name}" if output_name else "",
        "error": str(row[7] or ""),
        "attempt": int(row[8] or 0),
        "createdAt": int(row[9] or 0),
        "updatedAt": int(row[10] or 0),
        "completedAt": int(row[11] or 0) if row[11] is not None else None,
        "claimed": bool(claimed),
        "reused": bool(reused),
    }


def begin_video_compose_operation(
    owner_id,
    operation_key,
    production_id,
    request_fingerprint,
    *,
    stale_after_ms=6 * 60 * 60 * 1000,
):
    """Atomically claim one owner-scoped compose identity.

    The SQLite primary key is the cross-process authority.  A running claim is
    never stolen while its lease is current; failed or stale interrupted work
    can be retried with a fresh token.  Successful rows are immutable replays.
    """

    _ensure_db()
    owner = str(owner_id or "").strip()
    key = str(operation_key or "").strip()[:240]
    production = str(production_id or "").strip()[:160]
    fingerprint = str(request_fingerprint or "").strip().lower()
    if not owner or not key or not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise ValueError("invalid_video_compose_identity")
    now = int(time.time() * 1000)
    claim_token = secrets.token_hex(24)
    stale_cutoff = now - max(60_000, int(stale_after_ms or 0))
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if not conn.execute("SELECT 1 FROM members WHERE id=?", (owner,)).fetchone():
                raise ValueError("video_compose_owner_missing")
            row = conn.execute(
                f"SELECT {_VIDEO_COMPOSE_OPERATION_COLUMNS} "
                "FROM video_compose_operations WHERE owner_id=? AND operation_key=?",
                (owner, key),
            ).fetchone()
            if row and str(row[3]) != fingerprint:
                raise VideoComposeOperationConflict("video_compose_idempotency_conflict")
            if row and str(row[4]) == "succeeded":
                conn.commit()
                return _video_compose_operation_public(row, reused=True)
            if row and str(row[4]) == "running" and int(row[10] or 0) > stale_cutoff:
                conn.commit()
                return _video_compose_operation_public(row)
            if row:
                conn.execute(
                    "UPDATE video_compose_operations SET production_id=?,state='running',"
                    "claim_token=?,output_name='',error='',attempt=attempt+1,updated_at=?,"
                    "completed_at=NULL WHERE owner_id=? AND operation_key=?",
                    (production, claim_token, now, owner, key),
                )
            else:
                conn.execute(
                    "INSERT INTO video_compose_operations("
                    "owner_id,operation_key,production_id,request_fingerprint,state,"
                    "claim_token,output_name,error,attempt,created_at,updated_at,completed_at"
                    ") VALUES(?,?,?,?,'running',?,'','',1,?,?,NULL)",
                    (owner, key, production, fingerprint, claim_token, now, now),
                )
            row = conn.execute(
                f"SELECT {_VIDEO_COMPOSE_OPERATION_COLUMNS} "
                "FROM video_compose_operations WHERE owner_id=? AND operation_key=?",
                (owner, key),
            ).fetchone()
            conn.commit()
            return _video_compose_operation_public(row, claimed=True)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def get_video_compose_operation(owner_id, operation_key):
    _ensure_db()
    owner = str(owner_id or "").strip()
    key = str(operation_key or "").strip()[:240]
    with _lock:
        conn = _connect(read_only=True)
        try:
            row = conn.execute(
                f"SELECT {_VIDEO_COMPOSE_OPERATION_COLUMNS} "
                "FROM video_compose_operations WHERE owner_id=? AND operation_key=?",
                (owner, key),
            ).fetchone()
            return _video_compose_operation_public(row)
        finally:
            conn.close()


def fail_video_compose_operation(owner_id, operation_key, claim_token, error):
    """Release only the caller's own claim; a successful replay stays final."""

    _ensure_db()
    owner = str(owner_id or "").strip()
    key = str(operation_key or "").strip()[:240]
    token = str(claim_token or "").strip()
    message = str(error or "视频合成失败")[:1000]
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            updated = conn.execute(
                "UPDATE video_compose_operations SET state='failed',claim_token='',"
                "error=?,updated_at=?,completed_at=? WHERE owner_id=? AND operation_key=? "
                "AND state='running' AND claim_token=?",
                (message, now, now, owner, key, token),
            ).rowcount
            conn.commit()
            return bool(updated)
        finally:
            conn.close()


def complete_video_compose_operation(
    owner_id,
    operation_key,
    claim_token,
    output_name,
    *,
    team_id="",
):
    """Atomically register the private file and publish one successful result."""

    _ensure_db()
    owner = str(owner_id or "").strip()
    key = str(operation_key or "").strip()[:240]
    token = str(claim_token or "").strip()
    media_key = _normalize_private_media_key("composed", output_name)[1]
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                f"SELECT {_VIDEO_COMPOSE_OPERATION_COLUMNS} "
                "FROM video_compose_operations WHERE owner_id=? AND operation_key=?",
                (owner, key),
            ).fetchone()
            if not row or str(row[4]) != "running" or not hmac.compare_digest(str(row[5] or ""), token):
                raise VideoComposeOperationClaimLost("video_compose_claim_lost")
            _register_private_media_locked(
                conn,
                "composed",
                media_key,
                owner,
                team_id=team_id,
                provenance_kind="video-compose",
                provenance_id=key,
                now=now,
            )
            updated = conn.execute(
                "UPDATE video_compose_operations SET state='succeeded',claim_token='',"
                "output_name=?,error='',updated_at=?,completed_at=? "
                "WHERE owner_id=? AND operation_key=? AND state='running' AND claim_token=?",
                (media_key, now, now, owner, key, token),
            ).rowcount
            if updated != 1:
                raise VideoComposeOperationClaimLost("video_compose_claim_lost")
            row = conn.execute(
                f"SELECT {_VIDEO_COMPOSE_OPERATION_COLUMNS} "
                "FROM video_compose_operations WHERE owner_id=? AND operation_key=?",
                (owner, key),
            ).fetchone()
            conn.commit()
            return _video_compose_operation_public(row)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


_SUPPLIER_MEDIA_ROLES = {"supplier", "supplier_parent", "supplier_child"}
_DELIVERY_READABLE_MEDIA_KINDS = {"upload", "composed", "video-output"}


def _delivery_media_identity(value):
    """Return one local private-media identity from a persisted delivery URL."""

    raw = str(value or "").strip()
    if not raw or any(char.isspace() for char in raw):
        return None
    parsed = urlparse(raw)
    # Historical rows may contain this application's configured public origin.
    # Accept only an explicitly approved origin; an arbitrary external host may
    # still mimic our paths and must never become local ownership evidence.
    if parsed.scheme or parsed.netloc:
        origin = _private_media_url_origin(raw)
        if not origin or origin not in _private_media_allowed_absolute_origins():
            return None
    try:
        path = unquote_to_bytes(parsed.path).decode("utf-8")
    except (UnicodeDecodeError, ValueError):
        return None
    for prefix, kind in (
        ("/api/files/", "upload"),
        ("/api/video/composed/", "composed"),
        ("/custom-video/outputs/", "video-output"),
    ):
        if not path.startswith(prefix):
            continue
        try:
            return _normalize_private_media_key(kind, path[len(prefix):])
        except ValueError:
            return None
    return None


def _supplier_delivery_media_allowed_locked(
    conn,
    requester,
    role,
    delivery_id,
    media_kind,
    media_key,
):
    """Grant a supplier one exact read through one visible delivery.

    This is deliberately not a tenant-wide media grant.  The caller must name
    the delivery, the supplier must pass the existing parent/child visibility
    policy for that row, and the requested file must be the row's final video
    or an asset document referenced as its cover/pack/source dependency.
    """

    did = str(delivery_id or "").strip()
    if role not in _SUPPLIER_MEDIA_ROLES or not did:
        return False
    if media_kind not in _DELIVERY_READABLE_MEDIA_KINDS:
        return False
    row = conn.execute(
        "SELECT data FROM docs WHERE collection='assets' AND id=?",
        (did,),
    ).fetchone()
    if not row:
        return False
    try:
        delivery = json.loads(row[0])
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(delivery, dict) or not delivery.get("delivered"):
        return False
    if not _delivery_asset_access(delivery, requester, role, conn):
        return False

    target = (media_kind, media_key)
    if _delivery_media_identity(delivery.get("videoUrl")) == target:
        return True

    pack_ids = delivery.get("packAssetIds")
    if not isinstance(pack_ids, (list, tuple)):
        pack_ids = []
    dependency_ids = []
    for value in (
        delivery.get("coverAssetId"),
        delivery.get("sourceAssetId"),
        *pack_ids[:20],
    ):
        asset_id = str(value or "").strip()
        if asset_id and asset_id not in dependency_ids:
            dependency_ids.append(asset_id)
    if not dependency_ids:
        return False
    placeholders = ",".join("?" for _ in dependency_ids)
    rows = conn.execute(
        f"SELECT id,data FROM docs WHERE collection='assets' "
        f"AND id IN ({placeholders})",
        tuple(dependency_ids),
    ).fetchall()
    for asset_id, raw in rows:
        if str(asset_id) not in dependency_ids:
            continue
        try:
            asset = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(asset, dict):
            continue
        if media_kind == "upload" and str(asset.get("serverFileName") or "").strip() == media_key:
            return True
        for field in ("fileUrl", "url", "videoUrl", "downloadUrl"):
            if _delivery_media_identity(asset.get(field)) == target:
                return True
    return False


def private_media_access(kind, key, member_id, delivery_id=""):
    """Resolve owner/team access; platform role never grants a global bypass."""

    media_kind, media_key = _normalize_private_media_key(kind, key)
    requester = str(member_id or "").strip()
    if not requester:
        return None, "forbidden"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            member_row = conn.execute(
                "SELECT role FROM members WHERE id=?", (requester,),
            ).fetchone()
            if not member_row:
                return None, "forbidden"
            role = str(member_row[0] or "")
            rows = conn.execute(
                "SELECT media_kind,media_key,owner_id,team_id,provenance_kind,"
                "provenance_id,created_at,updated_at FROM private_media_registry "
                "WHERE media_kind=? AND media_key=? "
                "ORDER BY CASE WHEN owner_id=? THEN 0 ELSE 1 END,owner_id",
                (media_kind, media_key, requester),
            ).fetchall()
            if not rows:
                return None, "unregistered"
            teams = set(_private_media_member_teams_locked(conn, requester))
            for row in rows:
                owner = str(row[2])
                team = str(row[3] or "")
                if owner == requester or (team and team in teams):
                    return _private_media_row_public(row), None
                if _supplier_delivery_media_allowed_locked(
                    conn,
                    requester,
                    role,
                    delivery_id,
                    media_kind,
                    media_key,
                ):
                    record = _private_media_row_public(row)
                    record["deliveryId"] = str(delivery_id or "").strip()
                    record["accessVia"] = "supplier-delivery"
                    return record, None
            return None, "forbidden"
        finally:
            conn.close()


def private_media_data_migration_completed():
    """Cheap ledger check used to retire local legacy-read compatibility."""

    if not DB_PATH.is_file():
        return False
    try:
        conn = _connect(read_only=True)
    except sqlite3.Error:
        return False
    try:
        if not _table_exists_locked(conn, "schema_migrations"):
            return False
        row = conn.execute(
            "SELECT checksum,status FROM schema_migrations WHERE version=?",
            (PRIVATE_MEDIA_DATA_MIGRATION_VERSION,),
        ).fetchone()
        return row == (PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM, "success")
    except sqlite3.Error:
        return False
    finally:
        conn.close()


def legacy_private_media_document_access(kind, key, member_id, role=""):
    """Resolve an unregistered local file from persisted document ownership.

    This compatibility path deliberately has no role-level administrator
    bypass.  Once 140004 is complete (or strict mode is configured), callers
    must not use it.
    """

    identity = _normalize_private_media_key(kind, key)
    requester = str(member_id or "").strip()
    if not requester:
        return None
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            if not conn.execute(
                "SELECT 1 FROM members WHERE id=?", (requester,),
            ).fetchone():
                return None
            scoped = _resource_scopes_enforced_locked(conn)
            for collection, resource_id, stored_owner, encoded in conn.execute(
                "SELECT collection,id,owner_id,data FROM docs ORDER BY collection,id"
            ).fetchall():
                try:
                    payload = json.loads(encoded)
                except (TypeError, json.JSONDecodeError):
                    continue
                references = set()
                _private_media_collect_references(payload, references)
                if identity not in references:
                    continue
                owner_candidates = {
                    str(value or "").strip()
                    for value in (
                        stored_owner,
                        payload.get("ownerId") if isinstance(payload, dict) else "",
                        payload.get("byMemberId") if isinstance(payload, dict) else "",
                        payload.get("createdBy") if isinstance(payload, dict) else "",
                    )
                    if str(value or "").strip()
                }
                if scoped:
                    allowed = _resource_scope_allows_actor_locked(
                        conn, collection, resource_id, requester, role,
                    )
                else:
                    allowed = requester in owner_candidates
                if not allowed:
                    continue
                owner = (
                    requester if requester in owner_candidates
                    else next(
                        (
                            candidate for candidate in sorted(owner_candidates)
                            if conn.execute(
                                "SELECT 1 FROM members WHERE id=?", (candidate,),
                            ).fetchone()
                        ),
                        requester,
                    )
                )
                return {
                    "kind": identity[0],
                    "key": identity[1],
                    "ownerId": owner,
                    "teamId": "",
                    "legacy": True,
                }
            return None
        finally:
            conn.close()


def unregister_private_media(kind, key, owner_id):
    media_kind, media_key = _normalize_private_media_key(kind, key)
    owner = str(owner_id or "").strip()
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            cursor = conn.execute(
                "DELETE FROM private_media_registry "
                "WHERE media_kind=? AND media_key=? AND owner_id=?",
                (media_kind, media_key, owner),
            )
            conn.commit()
            return bool(cursor.rowcount)
        finally:
            conn.close()


def _private_media_url_origin(value):
    """Return a canonical HTTP origin, or an empty string when invalid."""

    try:
        parsed = urlparse(str(value or "").strip())
        scheme = parsed.scheme.lower()
        if (
            scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            return ""
        port = parsed.port
    except (TypeError, ValueError):
        return ""
    default_port = 443 if scheme == "https" else 80
    suffix = "" if port in {None, default_port} else f":{port}"
    return f"{scheme}://{parsed.hostname.lower()}{suffix}"


def _private_media_allowed_absolute_origins():
    configured = [os.getenv("PUBLIC_BASE_URL", "")]
    configured.extend(
        item.strip()
        for item in os.getenv("PRIVATE_MEDIA_LEGACY_ORIGINS", "").split(",")
        if item.strip()
    )
    return {
        origin for origin in map(_private_media_url_origin, configured) if origin
    }


def _private_media_reference(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    # Relative application URLs may carry cache-busting query parameters just
    # like approved absolute URLs. Ownership is keyed by canonical path only.
    path = parsed.path
    prefixes = (
        ("/api/files/", "upload"),
        ("/api/video/composed/", "composed"),
        ("/api/custom-canvas/blobs/", "canvas-blob"),
        ("/custom-video/outputs/", "video-output"),
        ("/custom-video/uploads/", "video-upload"),
        ("/outputs/", "video-output"),
        ("/uploads/", "video-upload"),
    )
    for prefix, kind in prefixes:
        if not path.startswith(prefix):
            continue
        if parsed.scheme or parsed.netloc:
            origin = _private_media_url_origin(raw)
            if not origin or origin not in _private_media_allowed_absolute_origins():
                # An external host may deliberately mimic our application
                # paths; never let it become local ownership evidence.
                return ("invalid", "")
        try:
            return _normalize_private_media_key(kind, path[len(prefix):])
        except ValueError:
            return ("invalid", "")
    return None


def _private_media_collect_references(value, output):
    if isinstance(value, list):
        for item in value:
            _private_media_collect_references(item, output)
    elif isinstance(value, dict):
        for item in value.values():
            _private_media_collect_references(item, output)
    elif isinstance(value, str):
        reference = _private_media_reference(value)
        if reference:
            output.add(reference)


def _private_media_inventory_files(root, kind, *, recursive):
    root = Path(root).expanduser()
    if not root.is_dir():
        return [], {"missingRoots": 1, "unsafeEntries": 0, "temporaryFiles": 0}
    paths = root.rglob("*") if recursive else root.iterdir()
    items = []
    issues = {"missingRoots": 0, "unsafeEntries": 0, "temporaryFiles": 0}
    for path in paths:
        try:
            if path.is_symlink():
                issues["unsafeEntries"] += 1
                continue
            if not path.is_file():
                if not recursive and path != root:
                    issues["unsafeEntries"] += 1
                continue
            relative = path.relative_to(root).as_posix()
            if relative.endswith(".tmp"):
                issues["temporaryFiles"] += 1
                continue
            if kind == "upload" and relative.startswith("member-avatar-"):
                # Member avatars are an explicit public profile-media route,
                # not part of the private asset URL namespace.
                continue
            try:
                media_kind, media_key = _normalize_private_media_key(kind, relative)
            except ValueError:
                issues["unsafeEntries"] += 1
                continue
            items.append((media_kind, media_key, path))
        except OSError:
            issues["unsafeEntries"] += 1
    return items, issues


def _private_media_live_inventory_digest():
    """Content-hash frozen live media trees like a runtime snapshot.

    This deliberately reads every media byte and is therefore reserved for
    explicit migration maintenance windows.  Normal readiness never calls it.
    """

    digest = hashlib.sha256()
    components = (
        ("uploads", PRIVATE_MEDIA_UPLOAD_DIR),
        ("composed", PRIVATE_MEDIA_COMPOSED_DIR),
        ("canvas-blobs", CUSTOM_CANVAS_BLOB_DIR),
        ("video-uploads", PRIVATE_MEDIA_VIDEO_UPLOAD_DIR),
        ("video-outputs", PRIVATE_MEDIA_VIDEO_OUTPUT_DIR),
    )
    for name, raw_root in sorted(components):
        root = Path(raw_root).expanduser()
        if not root.is_dir():
            digest.update(f"{name}\0absent\0".encode("utf-8"))
            continue
        entries = []
        for path in root.rglob("*"):
            try:
                if path.is_symlink():
                    raise StoreNotReadyError(
                        "live media inventory contains a symbolic link"
                    )
                if not path.is_file():
                    continue
                before = path.stat()
                content_digest = hashlib.sha256()
                with path.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                        content_digest.update(chunk)
                after = path.stat()
                if (
                    before.st_size != after.st_size
                    or before.st_mtime_ns != after.st_mtime_ns
                ):
                    raise StoreNotReadyError(
                        "live media changed during inventory hashing"
                    )
                entries.append((
                    path.relative_to(root).as_posix(),
                    int(before.st_size),
                    int(before.st_mtime_ns),
                    content_digest.hexdigest(),
                ))
            except OSError as exc:
                raise StoreNotReadyError(
                    "live media inventory is unavailable"
                ) from exc
        for relative, size, mtime_ns, content_sha256 in sorted(entries):
            digest.update(
                f"{name}\0{relative}\0{size}\0{mtime_ns}\0"
                f"{content_sha256}\0".encode("utf-8")
            )
    return digest.hexdigest()


def _private_media_active_teams_by_member_locked(conn):
    teams = {}
    for member_id, team_id in conn.execute(
        "SELECT member_id,team_id FROM team_members WHERE status='active' "
        "ORDER BY member_id,team_id"
    ).fetchall():
        teams.setdefault(str(member_id), []).append(str(team_id))
    return teams


def _private_media_plan_locked(
    conn,
    *,
    override_entries=None,
    override_manifest_sha256="",
    override_inventory_digest="",
    snapshot_manifest_sha256="",
    snapshot_media_inventory_digest="",
    override_database_logical_sha256="",
    include_database_logical_digest=False,
    include_media_content_digest=False,
):
    """Build a deterministic, redacted legacy-attribution plan.

    The plan never infers ownership from a directory alone.  It accepts only
    persisted document authorship, the server-generated upload owner prefix,
    canvas owner rows, workshop project mappings, community authorship, or an
    already registered row.  One disagreement blocks the whole data migration.
    """

    tables = {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    required = {"members", "team_members", "docs", "community_posts", "custom_canvas_blobs", "private_media_registry", "schema_migrations"}
    if not required.issubset(tables):
        missing = len(required - tables)
        return {
            "ok": False,
            "readyForApply": False,
            "issues": ["schema-not-ready"],
            "counts": {"missingTables": missing},
            "rows": [],
        }

    members = {
        str(row[0])
        for row in conn.execute("SELECT id FROM members").fetchall()
    }
    teams_by_member = _private_media_active_teams_by_member_locked(conn)
    inventory = {}
    issue_counts = {
        "missingRoots": 0,
        "unsafeEntries": 0,
        "temporaryFiles": 0,
        "invalidDocuments": 0,
        "invalidReferences": 0,
        "missingReferenceOwners": 0,
        "missingReferencedFiles": 0,
        "quarantinedFiles": 0,
        "ambiguousFiles": 0,
        "teamBindingConflicts": 0,
        "registryMissingFiles": 0,
        "canvasFilesystemQuarantined": 0,
        "overrideMissing": 0,
        "overrideExtra": 0,
        "overrideInvalidTargets": 0,
        "overrideScopeConflicts": 0,
        "overrideInventoryMismatch": 0,
        "overrideDatabaseMismatch": 0,
        "snapshotInventoryMismatch": 0,
    }
    for root, kind, recursive in (
        (PRIVATE_MEDIA_UPLOAD_DIR, "upload", False),
        (PRIVATE_MEDIA_COMPOSED_DIR, "composed", False),
        (PRIVATE_MEDIA_VIDEO_OUTPUT_DIR, "video-output", True),
        (PRIVATE_MEDIA_VIDEO_UPLOAD_DIR, "video-upload", True),
    ):
        files, file_issues = _private_media_inventory_files(
            root, kind, recursive=recursive,
        )
        for name, count in file_issues.items():
            issue_counts[name] += int(count)
        for media_kind, media_key, path in files:
            inventory[(media_kind, media_key)] = path

    candidates = {}
    provenance = {}
    referenced = set()
    reference_scopes = {}
    resource_scope_rows = {
        (str(kind), str(resource_id)): (str(scope_type), str(scope_id))
        for kind, resource_id, scope_type, scope_id in conn.execute(
            "SELECT resource_kind,resource_id,scope_type,scope_id "
            "FROM resource_scopes"
        ).fetchall()
    } if "resource_scopes" in tables else {}

    def add_reference(identity, scope=None):
        """Record business usage independently from attribution evidence."""

        if not identity:
            return False
        if identity[0] == "invalid":
            issue_counts["invalidReferences"] += 1
            return False
        referenced.add(identity)
        if scope and scope[0] in {"team", "member"} and scope[1]:
            reference_scopes.setdefault(identity, set()).add(
                (str(scope[0]), str(scope[1]))
            )
        return True

    def add_candidate(identity, owner_id, provenance_kind, provenance_id):
        if not identity or identity[0] == "invalid":
            return
        owner = str(owner_id or "").strip()
        if owner not in members:
            return
        candidates.setdefault(identity, set()).add(owner)
        provenance.setdefault((identity, owner), set()).add((
            str(provenance_kind or "")[:80],
            str(provenance_id or "")[:240],
        ))

    workshop_projects = {}
    document_rows = conn.execute(
        "SELECT collection,id,owner_id,data FROM docs ORDER BY collection,id"
    ).fetchall()
    for collection, document_id, stored_owner, encoded in document_rows:
        try:
            payload = json.loads(encoded)
        except (TypeError, json.JSONDecodeError):
            issue_counts["invalidDocuments"] += 1
            continue
        owner_candidates = {
            str(value or "").strip()
            for value in (
                stored_owner,
                payload.get("ownerId") if isinstance(payload, dict) else "",
                payload.get("byMemberId") if isinstance(payload, dict) else "",
            )
            if str(value or "").strip() in members
        }
        references = set()
        _private_media_collect_references(payload, references)
        document_scope = resource_scope_rows.get(
            (_doc_resource_kind(collection), str(document_id))
        )
        for identity in references:
            if not add_reference(identity, document_scope):
                continue
            for owner in owner_candidates:
                add_candidate(identity, owner, f"doc:{collection}", document_id)
        if str(collection) == "customProjects" and isinstance(payload, dict):
            state = payload.get("projectState") if isinstance(payload.get("projectState"), dict) else {}
            workshop_id = str(state.get("workshopProjectId") or "").strip()
            for owner in owner_candidates:
                if workshop_id:
                    workshop_projects.setdefault(workshop_id, set()).add(owner)

    for post_id, author_id, post_team_id, media_json, cover_json in conn.execute(
        "SELECT id,author_id,team_id,media_json,cover_json FROM community_posts "
        "WHERE status='published' ORDER BY id"
    ).fetchall():
        references = set()
        for encoded in (media_json, cover_json):
            try:
                payload = json.loads(encoded or "{}")
            except (TypeError, json.JSONDecodeError):
                issue_counts["invalidDocuments"] += 1
                continue
            _private_media_collect_references(payload, references)
        post_scope = None
        if post_team_id and conn.execute(
            "SELECT 1 FROM teams WHERE id=? AND status='active'",
            (str(post_team_id),),
        ).fetchone():
            post_scope = ("team", str(post_team_id))
        elif str(author_id) in members:
            member_scope = _member_resource_scope_locked(conn, author_id)
            if member_scope:
                post_scope = (member_scope[0], member_scope[1])
        for identity in references:
            if not add_reference(identity, post_scope):
                continue
            add_candidate(identity, author_id, "community-post", post_id)

    # Existing registrations are provenance, but never override disagreement
    # with documents or a server-generated owner prefix.
    registry_rows = conn.execute(
        "SELECT media_kind,media_key,owner_id,team_id,provenance_kind,"
        "provenance_id,created_at,updated_at FROM private_media_registry "
        "ORDER BY media_kind,media_key,owner_id"
    ).fetchall()
    existing_registry = {}
    for row in registry_rows:
        identity = (str(row[0]), str(row[1]))
        existing_registry[(identity, str(row[2]))] = row
        registry_scope = (
            ("team", str(row[3]))
            if str(row[3] or "")
            else ("member", str(row[2]))
        )
        add_reference(identity, registry_scope)
        add_candidate(identity, row[2], row[4], row[5])
        if identity[0] != "canvas-blob" and identity not in inventory:
            issue_counts["registryMissingFiles"] += 1

    # Upload names are generated as member-id--asset-id.ext by the server.
    for identity in sorted(inventory):
        kind, key = identity
        if kind == "upload" and "--" in key:
            prefix = key.split("--", 1)[0]
            if prefix in members:
                add_candidate(identity, prefix, "upload-owner-prefix", key)
        if kind in {"video-output", "video-upload"}:
            project_id = key.split("/", 1)[0]
            for owner in workshop_projects.get(project_id, set()):
                add_candidate(identity, owner, "video-workshop-project", project_id)

    canvas_rows = conn.execute(
        "SELECT owner_id,content_hash,stored_name FROM custom_canvas_blobs "
        "ORDER BY owner_id,content_hash"
    ).fetchall()
    canvas_expected_paths = set()
    canvas_present_identities = set()
    canvas_quarantine = []
    canvas_plan = []
    for owner_id, content_hash, stored_name in canvas_rows:
        identity = ("canvas-blob", str(content_hash))
        owner = str(owner_id)
        member_scope = _member_resource_scope_locked(conn, owner)
        add_reference(
            identity,
            (member_scope[0], member_scope[1]) if member_scope else None,
        )
        add_candidate(identity, owner, "custom-canvas-blob", content_hash)
        try:
            path = _custom_canvas_blob_path(stored_name)
        except ValueError:
            issue_counts["unsafeEntries"] += 1
            continue
        canvas_expected_paths.add(path.resolve(strict=False))
        if path.is_file():
            canvas_present_identities.add(identity)
        canvas_plan.append((identity, owner))
    canvas_root = CUSTOM_CANVAS_BLOB_DIR.expanduser()
    if canvas_root.is_dir():
        for path in canvas_root.rglob("*"):
            if path.is_file() and path.resolve(strict=False) not in canvas_expected_paths:
                issue_counts["canvasFilesystemQuarantined"] += 1
                try:
                    canvas_quarantine.append((
                        path.relative_to(canvas_root).as_posix(),
                        int(path.stat().st_size),
                    ))
                except OSError:
                    canvas_quarantine.append((path.name, -1))
    else:
        issue_counts["missingRoots"] += 1

    inventory_digest = hashlib.sha256()
    for (kind, key), path in sorted(inventory.items()):
        try:
            size = int(path.stat().st_size)
        except OSError:
            size = -1
        inventory_digest.update(
            f"{kind}\0{key}\0{size}\n".encode("utf-8")
        )
    for identity, owner in sorted(canvas_plan):
        inventory_digest.update(
            f"{identity[0]}\0{identity[1]}\0{owner}\n".encode("utf-8")
        )
    for relative, size in sorted(canvas_quarantine):
        inventory_digest.update(
            f"canvas-quarantine\0{relative}\0{size}\n".encode("utf-8")
        )
    inventory_digest_value = inventory_digest.hexdigest()
    live_media_inventory_digest = ""
    if include_media_content_digest:
        live_media_inventory_digest = _private_media_live_inventory_digest()
    if snapshot_media_inventory_digest:
        if (
            not live_media_inventory_digest
            or not hmac.compare_digest(
                str(snapshot_media_inventory_digest),
                live_media_inventory_digest,
            )
        ):
            issue_counts["snapshotInventoryMismatch"] += 1
    missing_file_identities = {
        identity for identity in referenced
        if (
            identity not in canvas_present_identities
            if identity[0] == "canvas-blob"
            else identity not in inventory
        )
    }
    issue_counts["missingReferencedFiles"] = len(missing_file_identities)

    migration_row = conn.execute(
        "SELECT checksum,status,summary FROM schema_migrations WHERE version=?",
        (PRIVATE_MEDIA_DATA_MIGRATION_VERSION,),
    ).fetchone()
    migrated = bool(
        migration_row
        and migration_row[0] == PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM
        and migration_row[1] == "success"
    )
    migration_running = bool(
        migration_row
        and migration_row[0] == PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM
        and migration_row[1] == "running"
    )
    override_entries = list(override_entries or [])
    database_logical_digest_value = (
        _database_logical_digest_locked(conn)
        if include_database_logical_digest or override_entries
        else ""
    )
    override_by_identity = {
        (entry["mediaKind"], entry["mediaKey"]): entry
        for entry in override_entries
    }
    unresolved_before_override = {
        identity for identity in referenced if not candidates.get(identity)
    }
    eligible_override_identities = (
        unresolved_before_override - missing_file_identities
    )
    if override_entries:
        if not hmac.compare_digest(
            str(override_inventory_digest or ""), inventory_digest_value,
        ):
            issue_counts["overrideInventoryMismatch"] += 1
        supplied = set(override_by_identity)
        if migrated:
            try:
                stored_summary = json.loads(str(migration_row[2] or "{}"))
            except (TypeError, json.JSONDecodeError):
                stored_summary = {}
            if (
                str(stored_summary.get("overrideManifestSha256") or "")
                != str(override_manifest_sha256 or "")
                or int(stored_summary.get("overrideEntries") or 0)
                != len(override_entries)
                or str(stored_summary.get("snapshotManifestSha256") or "")
                != str(snapshot_manifest_sha256 or "")
                or str(stored_summary.get("snapshotMediaInventoryDigest") or "")
                != str(snapshot_media_inventory_digest or "")
                or str(stored_summary.get("overrideDatabaseLogicalSha256") or "")
                != str(override_database_logical_sha256 or "")
            ):
                issue_counts["overrideExtra"] += 1
        elif migration_running:
            issue_counts["overrideMissing"] = sum(
                1
                for identity, entry in override_by_identity.items()
                if ((identity, str(entry["ownerId"]))) not in existing_registry
            )
        else:
            if not hmac.compare_digest(
                str(override_database_logical_sha256 or ""),
                database_logical_digest_value,
            ):
                issue_counts["overrideDatabaseMismatch"] += 1
            issue_counts["overrideMissing"] = len(
                eligible_override_identities - supplied
            )
            issue_counts["overrideExtra"] = len(
                supplied - eligible_override_identities
            )
            if not any((
                issue_counts["overrideMissing"],
                issue_counts["overrideExtra"],
                issue_counts["overrideInventoryMismatch"],
                issue_counts["overrideDatabaseMismatch"],
                issue_counts["snapshotInventoryMismatch"],
            )):
                for identity in sorted(supplied):
                    entry = override_by_identity[identity]
                    owner = str(entry["ownerId"])
                    if owner not in members:
                        issue_counts["overrideInvalidTargets"] += 1
                        continue
                    owner_scope = _member_resource_scope_locked(conn, owner)
                    scopes = reference_scopes.get(identity) or set()
                    if (
                        not owner_scope
                        or len(scopes) != 1
                        or (owner_scope[0], owner_scope[1]) not in scopes
                    ):
                        issue_counts["overrideScopeConflicts"] += 1
                        continue
                    add_candidate(
                        identity,
                        owner,
                        "operator-reviewed-media",
                        str(override_manifest_sha256 or "")[:16],
                    )

    rows = []
    planned_pairs = set()
    missing_reference_owners = {
        identity for identity in referenced
        if not candidates.get(identity)
    }
    issue_counts["missingReferenceOwners"] = len(missing_reference_owners)
    for identity in sorted(inventory):
        owners = sorted(candidates.get(identity) or set())
        if not owners:
            if identity not in referenced:
                # Preserve unknown legacy files in place, but do not register
                # or serve them.  Only files with no business reference at all
                # are quarantine warnings; an orphaned referenced file blocks.
                issue_counts["quarantinedFiles"] += 1
            continue
        if len(owners) != 1:
            issue_counts["ambiguousFiles"] += 1
            continue
        owner = owners[0]
        teams = teams_by_member.get(owner, [])
        if len(teams) > 1:
            issue_counts["teamBindingConflicts"] += 1
            continue
        proofs = sorted(provenance.get((identity, owner)) or set())
        proof = proofs[0] if proofs else ("legacy-media", identity[1])
        rows.append((identity[0], identity[1], owner, teams[0] if teams else "", proof[0], proof[1]))
        planned_pairs.add((identity, owner))
    for identity, owner in canvas_plan:
        teams = teams_by_member.get(owner, [])
        if owner not in members:
            continue
        if len(teams) > 1:
            issue_counts["teamBindingConflicts"] += 1
            continue
        pair = (identity, owner)
        if pair in planned_pairs:
            continue
        rows.append((identity[0], identity[1], owner, teams[0] if teams else "", "custom-canvas-blob", identity[1]))
        planned_pairs.add(pair)

    pending = 0
    registry_conflicts = 0
    for kind, key, owner, team_id, _proof_kind, _proof_id in rows:
        existing = existing_registry.get(((kind, key), owner))
        if not existing:
            pending += 1
            continue
        if str(existing[3] or "") != str(team_id or ""):
            registry_conflicts += 1
    issue_counts["registryConflicts"] = registry_conflicts
    warning_names = {
        "temporaryFiles",
        "quarantinedFiles",
        "canvasFilesystemQuarantined",
    }
    blocking = sum(
        value
        for name, value in issue_counts.items()
        if name not in warning_names
    )
    issues = sorted(
        name for name, value in issue_counts.items()
        if value and name not in warning_names
    )
    warnings = sorted(
        name for name, value in issue_counts.items()
        if value and name in warning_names
    )
    ready_for_apply = blocking == 0
    summary = {
        "ok": bool(ready_for_apply and migrated and pending == 0),
        "readyForApply": ready_for_apply,
        "dataMigration": migrated,
        "dataMigrationVersion": PRIVATE_MEDIA_DATA_MIGRATION_VERSION if migrated else None,
        "issues": issues,
        "warnings": warnings,
        "inventoryDigest": inventory_digest_value,
        "databaseLogicalSha256": database_logical_digest_value,
        "mediaInventoryDigest": live_media_inventory_digest,
        "overrideManifestSha256": str(override_manifest_sha256 or ""),
        "snapshotManifestSha256": str(snapshot_manifest_sha256 or ""),
        "snapshotMediaInventoryDigest": str(
            snapshot_media_inventory_digest or ""
        ),
        "counts": {
            **issue_counts,
            "inventory": len(inventory) + len(canvas_plan),
            "plannedRows": len(rows),
            "registeredRows": len(registry_rows),
            "pendingRows": pending,
            "overrideEntries": len(override_entries),
            "publicAvatarExemptions": sum(
                1
                for path in (PRIVATE_MEDIA_UPLOAD_DIR.iterdir() if PRIVATE_MEDIA_UPLOAD_DIR.is_dir() else [])
                if path.is_file() and path.name.startswith("member-avatar-")
            ),
        },
        "rows": rows,
    }
    return summary


def private_media_registry_status():
    """Read-only, redacted filesystem/DB coverage used by ``/api/ready``."""

    if not DB_PATH.is_file():
        return {
            "ok": False,
            "readyForApply": False,
            "dataMigration": False,
            "issues": ["database-missing"],
            "counts": {},
        }
    conn = _connect(read_only=True)
    try:
        conn.execute("BEGIN")
        plan = _private_media_plan_locked(conn)
        conn.rollback()
        return {key: value for key, value in plan.items() if key != "rows"}
    finally:
        conn.close()


def private_media_migration_preflight(
    *,
    expected_identity,
    expected_schema_version,
    override_manifest_path="",
    expected_override_manifest_sha256="",
    runtime_snapshot_binding=None,
    backup_binding=None,
):
    """Dry-run legacy media attribution without exposing file/member names."""

    if int(expected_schema_version or 0) != PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION:
        raise StoreNotReadyError("private media schema version confirmation mismatch")
    if not DB_PATH.is_file():
        raise StoreNotReadyError("migration target database must already exist")
    actual_identity = _database_identity(DB_PATH)
    if not hmac.compare_digest(str(expected_identity or ""), actual_identity):
        raise StoreNotReadyError("migration target database identity mismatch")
    snapshot_binding = _verify_runtime_snapshot_binding(
        runtime_snapshot_binding,
        required=bool(
            str(override_manifest_path or "").strip()
            or str(expected_override_manifest_sha256 or "").strip()
        ),
    )
    snapshot_manifest_digest = snapshot_binding["manifestSha256"]
    snapshot_media_digest = snapshot_binding["mediaInventoryDigest"]
    conn = _connect(read_only=True)
    try:
        if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
            raise StoreNotReadyError("migration target failed SQLite quick_check")
        conn.execute("BEGIN")
        override_requested = bool(
            str(override_manifest_path or "").strip()
            or str(expected_override_manifest_sha256 or "").strip()
        )
        if backup_binding is not None or override_requested:
            database_state = _verify_migration_backup_binding_locked(
                conn, backup_binding,
            )
        else:
            database_state = _database_review_state_locked(conn)
        (
            override_entries,
            override_digest,
            override_inventory,
            _override_snapshot,
            _override_snapshot_media,
            override_database_logical_digest,
        ) = _load_private_media_override_manifest(
            override_manifest_path,
            expected_override_manifest_sha256,
            database_state,
            snapshot_manifest_digest,
            snapshot_media_digest,
        )
        schema_row = conn.execute(
            "SELECT checksum,status FROM schema_migrations WHERE version=?",
            (PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,),
        ).fetchone()
        if schema_row != (PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM, "success"):
            raise StoreNotReadyError("private media schema migration is not ready")
        resource_row = conn.execute(
            "SELECT checksum,status FROM schema_migrations WHERE version=?",
            (RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
        ).fetchone()
        if resource_row != (RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM, "success"):
            raise StoreNotReadyError("resource scope data migration prerequisite is not ready")
        plan = _private_media_plan_locked(
            conn,
            override_entries=override_entries,
            override_manifest_sha256=override_digest,
            override_inventory_digest=override_inventory,
            snapshot_manifest_sha256=snapshot_manifest_digest,
            snapshot_media_inventory_digest=snapshot_media_digest,
            override_database_logical_sha256=(
                override_database_logical_digest
            ),
            include_database_logical_digest=True,
            include_media_content_digest=True,
        )
        conn.rollback()
        return {
            **{key: value for key, value in plan.items() if key != "rows"},
            **database_state,
            "dryRun": True,
        }
    finally:
        conn.close()


def apply_private_media_migration(
    *,
    expected_identity,
    expected_schema_version,
    backup_binding=None,
    override_manifest_path="",
    expected_override_manifest_sha256="",
    runtime_snapshot_binding=None,
):
    """Atomically register only a complete, deterministic legacy media plan."""

    global _initialized
    if runtime_config.is_read_only():
        raise StoreNotReadyError("read-only runtime cannot apply migrations")
    if runtime_config.runtime_mode() == "invalid":
        raise StoreNotReadyError("invalid ACG_RUNTIME_MODE")
    if str(os.getenv("ACG_ALLOW_PRIVATE_MEDIA_MIGRATION", "")).strip() != "1":
        raise StoreNotReadyError("private media migration authorization is required")
    if int(expected_schema_version or 0) != PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION:
        raise StoreNotReadyError("private media schema version confirmation mismatch")
    if not DB_PATH.is_file():
        raise StoreNotReadyError("migration target database must already exist")
    actual_identity = _database_identity(DB_PATH)
    if not hmac.compare_digest(str(expected_identity or ""), actual_identity):
        raise StoreNotReadyError("migration target database identity mismatch")

    snapshot_binding = _verify_runtime_snapshot_binding(
        runtime_snapshot_binding,
        required=(
            runtime_config.is_production()
            or bool(str(override_manifest_path or "").strip())
            or bool(str(expected_override_manifest_sha256 or "").strip())
        ),
    )
    snapshot_manifest_digest = snapshot_binding["manifestSha256"]
    snapshot_media_digest = snapshot_binding["mediaInventoryDigest"]

    applied_override_digest = ""
    applied_override_entries = 0
    applied_override_state = {}
    with _lock:
        conn = _connect_migration_target()
        migration_started = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            if not hmac.compare_digest(
                str(expected_identity or ""), _database_identity(DB_PATH),
            ):
                raise StoreNotReadyError("migration target database identity mismatch")
            override_requested = bool(
                str(override_manifest_path or "").strip()
                or str(expected_override_manifest_sha256 or "").strip()
            )
            # The CLI always supplies this binding. Production and every
            # operator override additionally refuse a direct call without it.
            if (
                runtime_config.is_production()
                or backup_binding is not None
                or override_requested
            ):
                database_state = _verify_migration_backup_binding_locked(
                    conn, backup_binding,
                )
            else:
                database_state = _database_review_state_locked(conn)
            (
                override_entries,
                override_digest,
                override_inventory,
                _override_snapshot,
                _override_snapshot_media,
                override_database_logical_digest,
            ) = _load_private_media_override_manifest(
                override_manifest_path,
                expected_override_manifest_sha256,
                database_state,
                snapshot_manifest_digest,
                snapshot_media_digest,
            )
            if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
                raise StoreNotReadyError("migration target failed SQLite quick_check")
            schema_row = conn.execute(
                "SELECT checksum,status FROM schema_migrations WHERE version=?",
                (PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,),
            ).fetchone()
            if schema_row != (PRIVATE_MEDIA_SCHEMA_MIGRATION_CHECKSUM, "success"):
                raise StoreNotReadyError("private media schema migration is not ready")
            resource_row = conn.execute(
                "SELECT checksum,status FROM schema_migrations WHERE version=?",
                (RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
            ).fetchone()
            if resource_row != (RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM, "success"):
                raise StoreNotReadyError("resource scope data migration prerequisite is not ready")
            plan = _private_media_plan_locked(
                conn,
                override_entries=override_entries,
                override_manifest_sha256=override_digest,
                override_inventory_digest=override_inventory,
                snapshot_manifest_sha256=snapshot_manifest_digest,
                snapshot_media_inventory_digest=snapshot_media_digest,
                override_database_logical_sha256=(
                    override_database_logical_digest
                ),
                include_database_logical_digest=True,
                include_media_content_digest=True,
            )
            if not plan.get("readyForApply"):
                raise StoreNotReadyError(
                    "private media migration preflight failed: "
                    + ",".join(plan.get("issues") or ["unknown"])
                )
            if plan.get("dataMigration") and plan.get("counts", {}).get("pendingRows") == 0:
                conn.rollback()
                return {
                    **{key: value for key, value in plan.items() if key != "rows"},
                    "applied": False,
                    "dryRun": False,
                    "databaseIdentity": actual_identity,
                }
            now = int(time.time() * 1000)
            conn.execute(
                "INSERT OR REPLACE INTO schema_migrations("
                "version,name,checksum,app_version,started_at,finished_at,status,summary"
                ") VALUES(?,?,?,?,?,NULL,'running','{}')",
                (
                    PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                    PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                    PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                    runtime_config.release_id() or "unidentified",
                    now,
                ),
            )
            migration_started = True
            for kind, key, owner, team_id, proof_kind, proof_id in plan["rows"]:
                _register_private_media_locked(
                    conn,
                    kind,
                    key,
                    owner,
                    team_id=team_id,
                    provenance_kind=proof_kind,
                    provenance_id=proof_id,
                    now=now,
                )
            verification = _private_media_plan_locked(
                conn,
                override_entries=override_entries,
                override_manifest_sha256=override_digest,
                override_inventory_digest=override_inventory,
                snapshot_manifest_sha256=snapshot_manifest_digest,
                snapshot_media_inventory_digest=snapshot_media_digest,
                override_database_logical_sha256=(
                    override_database_logical_digest
                ),
                include_database_logical_digest=True,
                include_media_content_digest=True,
            )
            if (
                not verification.get("readyForApply")
                or int(verification.get("counts", {}).get("pendingRows") or 0) != 0
            ):
                raise StoreNotReadyError("private media registry verification failed")
            audit_summary = {
                "counts": verification.get("counts") or {},
                "issues": verification.get("issues") or [],
                "overrideManifestSha256": override_digest,
                "overrideEntries": len(override_entries),
                "snapshotManifestSha256": snapshot_manifest_digest,
                "snapshotMediaInventoryDigest": snapshot_media_digest,
                "overrideDatabaseIdentity": (
                    database_state.get("databaseIdentity") if override_digest else ""
                ),
                "overrideDatabasePathSha256": (
                    database_state.get("databasePathSha256") if override_digest else ""
                ),
                "overrideDatabaseLogicalSha256": (
                    database_state.get("databaseLogicalSha256") if override_digest else ""
                ),
                "overrideSchemaVersion": (
                    database_state.get("schemaVersion") if override_digest else None
                ),
                "overrideUserVersion": (
                    database_state.get("userVersion") if override_digest else None
                ),
                "overrideBackupManifestSha256": (
                    database_state.get("backupManifestSha256") if override_digest else ""
                ),
            }
            conn.execute(
                "UPDATE schema_migrations SET finished_at=?,status='success',summary=? "
                "WHERE version=?",
                (
                    int(time.time() * 1000),
                    json.dumps(audit_summary, ensure_ascii=False, sort_keys=True),
                    PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                ),
            )
            conn.commit()
            applied_override_digest = override_digest
            applied_override_entries = len(override_entries)
            applied_override_state = (
                dict(database_state) if override_digest else {}
            )
            _initialized = False
        except Exception:
            conn.rollback()
            if migration_started:
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    now = int(time.time() * 1000)
                    existing = conn.execute(
                        "SELECT checksum FROM schema_migrations WHERE version=?",
                        (PRIVATE_MEDIA_DATA_MIGRATION_VERSION,),
                    ).fetchone()
                    if not existing or existing[0] == PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM:
                        conn.execute(
                            "INSERT OR REPLACE INTO schema_migrations("
                            "version,name,checksum,app_version,started_at,finished_at,status,summary"
                            ") VALUES(?,?,?,?,?,?,?,?)",
                            (
                                PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                                PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                                PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                                runtime_config.release_id() or "unidentified",
                                now,
                                now,
                                "failed",
                                json.dumps({"error": "migration_error"}),
                            ),
                        )
                        conn.commit()
                except Exception:
                    conn.rollback()
            raise
        finally:
            conn.close()

    result = private_media_migration_preflight(
        expected_identity=actual_identity,
        expected_schema_version=expected_schema_version,
        runtime_snapshot_binding=runtime_snapshot_binding,
    )
    return {
        **result,
        "appliedOverrideManifestSha256": applied_override_digest,
        "appliedOverrideEntries": applied_override_entries,
        "appliedOverrideDatabaseState": applied_override_state,
        "applied": True,
        "dryRun": False,
    }


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
    if runtime_config.is_read_only():
        raise StoreNotReadyError("AUTH_SECRET is unavailable in read-only mode")
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


def _team_public_row(row):
    if not row:
        return None
    return {
        "id": row[0],
        "name": row[1],
        "kind": row[2],
        "status": row[3],
        "plan": row[4],
        "quotaMode": row[5],
        "role": row[6],
    }


def member_team(member_id):
    row = _fetchone(
        "SELECT t.id,t.name,t.kind,t.status,t.plan,t.quota_mode,tm.team_role "
        "FROM team_members tm JOIN teams t ON t.id=tm.team_id "
        "WHERE tm.member_id=? AND tm.status='active' AND t.status='active'",
        (member_id,),
    )
    return _team_public_row(row)


def member_entitlements(member_id, role):
    if role in {"supplier_parent", "supplier_child"}:
        return ["supplier"]
    team = member_team(member_id)
    return list(TEAM_FEATURES if team else PERSONAL_FEATURES)


def _china_quota_day(now_ms=None):
    stamp = int(now_ms if now_ms is not None else time.time() * 1000)
    current = datetime.fromtimestamp(stamp / 1000, tz=CHINA_TZ)
    next_midnight = datetime.combine(
        current.date() + timedelta(days=1), datetime.min.time(), tzinfo=CHINA_TZ,
    )
    return current.date().isoformat(), int(next_midnight.timestamp() * 1000)


def _china_quota_month(now_ms=None):
    stamp = int(now_ms if now_ms is not None else time.time() * 1000)
    current = datetime.fromtimestamp(stamp / 1000, tz=CHINA_TZ)
    if current.month == 12:
        next_month = datetime(current.year + 1, 1, 1, tzinfo=CHINA_TZ)
    else:
        next_month = datetime(current.year, current.month + 1, 1, tzinfo=CHINA_TZ)
    return f"{current.year:04d}-{current.month:02d}", int(next_month.timestamp() * 1000)


def _quota_reset_at_for_month(quota_month):
    try:
        year, month = (int(value) for value in str(quota_month).split("-", 1))
        if not 1 <= month <= 12:
            raise ValueError("invalid month")
    except (TypeError, ValueError):
        current = datetime.now(CHINA_TZ)
        year, month = current.year, current.month
    if month == 12:
        next_month = datetime(year + 1, 1, 1, tzinfo=CHINA_TZ)
    else:
        next_month = datetime(year, month + 1, 1, tzinfo=CHINA_TZ)
    return int(next_month.timestamp() * 1000)


def _personal_quota_eligible_locked(conn, member_id):
    row = conn.execute(
        "SELECT m.role, EXISTS("
        "SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id "
        "WHERE tm.member_id=m.id AND tm.status='active' AND t.status='active'"
        ") FROM members m WHERE m.id=?",
        (member_id,),
    ).fetchone()
    return bool(row and row[0] == "user" and not row[1])


def _quota_reset_at_for_day(quota_day):
    try:
        current = datetime.fromisoformat(str(quota_day)).date()
    except (TypeError, ValueError):
        current = datetime.now(CHINA_TZ).date()
    next_midnight = datetime.combine(
        current + timedelta(days=1), datetime.min.time(), tzinfo=CHINA_TZ,
    )
    return int(next_midnight.timestamp() * 1000)


def _personal_quota_snapshot_locked(conn, member_id, quota_day):
    row = conn.execute(
        "SELECT granted_points,used_points FROM personal_daily_quotas "
        "WHERE member_id=? AND quota_day=?",
        (str(member_id or ""), str(quota_day or "")),
    ).fetchone()
    if not row:
        return None
    reserved = int(conn.execute(
        "SELECT COALESCE(SUM(points),0) FROM personal_daily_quota_reservations "
        "WHERE member_id=? AND quota_day=? AND status='active'",
        (str(member_id or ""), str(quota_day or "")),
    ).fetchone()[0] or 0)
    granted, used = int(row[0] or 0), int(row[1] or 0)
    remaining = max(0, granted - used - reserved)
    return {
        "type": "daily",
        "period": "day",
        "plan": "personal",
        "billingScope": {"type": "member", "id": str(member_id or "")},
        "day": str(quota_day),
        "limit": granted,
        "used": used,
        "reserved": reserved,
        "remaining": remaining,
        "available": remaining,
        "resetAt": _quota_reset_at_for_day(quota_day),
        "nonAccumulating": True,
    }


def _ensure_personal_quota_row_locked(conn, member_id, quota_day, now):
    conn.execute(
        "INSERT OR IGNORE INTO personal_daily_quotas("
        "member_id,quota_day,granted_points,used_points,updated_at"
        ") VALUES(?,?,?,?,?)",
        (str(member_id or ""), str(quota_day or ""), PERSONAL_DAILY_POINTS, 0, int(now)),
    )
    return _personal_quota_snapshot_locked(conn, member_id, quota_day)


def personal_daily_quota(member_id, now_ms=None):
    """Return the durable daily grant for a standalone personal user.

    A fresh row is created per China-local day, so unused points never carry
    into tomorrow while prior days remain auditable. Team and supplier members
    deliberately receive no personal grant row because their quota follows the
    team or supplier contract instead.
    """
    _ensure_db()
    day, _reset_at = _china_quota_day(now_ms)
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            if runtime_config.is_read_only():
                if not _personal_quota_eligible_locked(conn, member_id):
                    return None
                existing = _personal_quota_snapshot_locked(conn, member_id, day)
                if existing:
                    return existing
                return {
                    "type": "daily",
                    "period": "day",
                    "plan": "personal",
                    "billingScope": {"type": "member", "id": str(member_id or "")},
                    "day": str(day),
                    "limit": PERSONAL_DAILY_POINTS,
                    "used": 0,
                    "reserved": 0,
                    "remaining": PERSONAL_DAILY_POINTS,
                    "available": PERSONAL_DAILY_POINTS,
                    "resetAt": _quota_reset_at_for_day(day),
                    "nonAccumulating": True,
                    "projected": True,
                }
            conn.execute("BEGIN IMMEDIATE")
            if not _personal_quota_eligible_locked(conn, member_id):
                conn.rollback()
                return None
            result = _ensure_personal_quota_row_locked(conn, member_id, day, now)
            conn.commit()
        finally:
            conn.close()
    return result


def _reservation_result(row, quota, *, reused=False, retried=False):
    return {
        "reservationId": str(row[0] or ""),
        "quotaDay": str(row[2] or ""),
        "idempotencyKey": str(row[3] or ""),
        "points": int(row[4] or 0),
        "feature": str(row[5] or ""),
        "status": str(row[6] or ""),
        "createdAt": int(row[7] or 0),
        "updatedAt": int(row[8] or 0),
        "settledAt": int(row[9] or 0) if row[9] is not None else None,
        "releasedAt": int(row[10] or 0) if row[10] is not None else None,
        "requestFingerprint": str(row[11] or "") if len(row) > 11 else "",
        "reused": bool(reused),
        "retried": bool(retried),
        "quota": quota,
    }


def reserve_personal_daily_points(
    member_id,
    points,
    feature="",
    idempotency_key="",
    now_ms=None,
    request_fingerprint="",
):
    """Atomically freeze points before a billable upstream request.

    Only standalone ``user`` accounts receive a reservation. Team, ACG and
    supplier accounts return ``not_personal_user`` so callers can bypass this
    personal wallet without creating audit rows. A stable idempotency key is
    mandatory: concurrent repeats observe the same reservation and never freeze
    a second amount.
    """
    try:
        amount = int(points)
    except (TypeError, ValueError, OverflowError):
        amount = 0
    if amount <= 0:
        return None, "invalid_points"
    key = str(idempotency_key or "").strip()[:160]
    clean_feature = str(feature or "生成任务")[:80]
    fingerprint = str(request_fingerprint or "").strip()[:128]
    day, _reset_at = _china_quota_day(now_ms)
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    owner = str(member_id or "")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if not _personal_quota_eligible_locked(conn, owner):
                conn.rollback()
                return None, "not_personal_user"
            if not key:
                conn.rollback()
                return None, "idempotency_key_required"
            _ensure_personal_quota_row_locked(conn, owner, day, now)

            # Preserve idempotency across the older post-success deduction
            # primitive: a previously settled key must never fund a new call.
            settled_event = conn.execute(
                "SELECT quota_day,points,feature,created_at FROM personal_daily_quota_events "
                "WHERE member_id=? AND idempotency_key=?",
                (owner, key),
            ).fetchone()
            if settled_event:
                if int(settled_event[1] or 0) != amount:
                    conn.rollback()
                    return None, "idempotency_conflict"
                event_day = str(settled_event[0] or day)
                quota = _personal_quota_snapshot_locked(conn, owner, event_day)
                conn.commit()
                legacy_row = (
                    "", owner, event_day, key, amount,
                    str(settled_event[2] or clean_feature), "settled",
                    int(settled_event[3] or now), int(settled_event[3] or now),
                    int(settled_event[3] or now), None, "",
                )
                return _reservation_result(legacy_row, quota, reused=True), None

            previous = conn.execute(
                "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint "
                "FROM personal_daily_quota_reservations "
                "WHERE member_id=? AND idempotency_key=?",
                (owner, key),
            ).fetchone()
            if previous:
                if (
                    int(previous[4] or 0) != amount
                    or str(previous[5] or "") != clean_feature
                    or str(previous[11] or "") != fingerprint
                ):
                    conn.rollback()
                    return None, "idempotency_conflict"
                if str(previous[6]) == "released":
                    quota = _personal_quota_snapshot_locked(conn, owner, day)
                    if not quota or int(quota["remaining"]) < amount:
                        conn.commit()
                        return quota, "insufficient_points"
                    conn.execute(
                        "UPDATE personal_daily_quota_reservations SET "
                        "quota_day=?,status='active',updated_at=?,settled_at=NULL,released_at=NULL "
                        "WHERE id=? AND member_id=? AND status='released'",
                        (day, now, previous[0], owner),
                    )
                    previous = conn.execute(
                        "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                        "created_at,updated_at,settled_at,released_at,request_fingerprint "
                        "FROM personal_daily_quota_reservations WHERE id=? AND member_id=?",
                        (previous[0], owner),
                    ).fetchone()
                    quota = _personal_quota_snapshot_locked(conn, owner, day)
                    conn.commit()
                    return _reservation_result(previous, quota, retried=True), None
                quota = _personal_quota_snapshot_locked(conn, owner, previous[2])
                conn.commit()
                return _reservation_result(previous, quota, reused=True), None

            quota = _personal_quota_snapshot_locked(conn, owner, day)
            if not quota or int(quota["remaining"]) < amount:
                conn.commit()
                return quota, "insufficient_points"
            reservation_id = uuid.uuid4().hex
            conn.execute(
                "INSERT INTO personal_daily_quota_reservations("
                "id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint"
                ") VALUES(?,?,?,?,?,?, 'active',?,?,NULL,NULL,?)",
                (
                    reservation_id, owner, day, key, amount, clean_feature,
                    now, now, fingerprint,
                ),
            )
            row = conn.execute(
                "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint "
                "FROM personal_daily_quota_reservations WHERE id=?",
                (reservation_id,),
            ).fetchone()
            quota = _personal_quota_snapshot_locked(conn, owner, day)
            conn.commit()
            return _reservation_result(row, quota), None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def settle_personal_daily_points(
    member_id,
    reservation_id,
    now_ms=None,
    canvas_receipts=None,
    *,
    consumed_points=None,
):
    """Move one active freeze into used points exactly once.

    Optional Canvas receipts are validated before the transaction and inserted
    as charged in the same transaction as the quota settlement. This prevents
    a response from failing after points have already been committed.
    """
    owner = str(member_id or "")
    rid = str(reservation_id or "").strip()
    if not owner or not rid:
        return None, "reservation_not_found"
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    prepared_receipts = _prepare_custom_canvas_generation_receipts(
        owner, canvas_receipts, now,
    ) if canvas_receipts else []
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint "
                "FROM personal_daily_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            if not row:
                conn.rollback()
                return None, "reservation_not_found"
            status = str(row[6] or "")
            if status == "released":
                quota = _personal_quota_snapshot_locked(conn, owner, row[2])
                conn.commit()
                return _reservation_result(row, quota, reused=True), "reservation_released"
            if status == "settled":
                quota = _personal_quota_snapshot_locked(conn, owner, row[2])
                conn.commit()
                result = _reservation_result(row, quota, reused=True)
                result["deducted"] = 0
                result["generationReceipts"] = []
                return result, None
            if status != "active":
                conn.rollback()
                return None, "invalid_reservation_status"

            quota = _personal_quota_snapshot_locked(conn, owner, row[2])
            reserved_amount = int(row[4] or 0)
            amount = (
                reserved_amount
                if consumed_points is None
                else int(consumed_points)
            )
            if amount <= 0 or amount > reserved_amount:
                conn.rollback()
                return quota, "invalid_consumed_points"
            if prepared_receipts and sum(
                int(receipt.get("points") or 0) for receipt in prepared_receipts
            ) != amount:
                conn.rollback()
                return quota, "receipt_points_mismatch"
            if not quota or int(quota["used"]) + amount > int(quota["limit"]):
                conn.rollback()
                return quota, "insufficient_points"
            conn.execute(
                "UPDATE personal_daily_quotas SET used_points=used_points+?,updated_at=? "
                "WHERE member_id=? AND quota_day=?",
                (amount, now, owner, row[2]),
            )
            conn.execute(
                "INSERT INTO personal_daily_quota_events("
                "id,member_id,quota_day,idempotency_key,points,feature,created_at"
                ") VALUES(?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex[:16], owner, row[2], row[3], amount,
                    row[5], now,
                ),
            )
            conn.execute(
                "UPDATE personal_daily_quota_reservations SET "
                "status='settled',updated_at=?,settled_at=?,released_at=NULL "
                "WHERE id=? AND member_id=? AND status='active'",
                (now, now, rid, owner),
            )
            if prepared_receipts:
                _insert_custom_canvas_generation_receipts_locked(
                    conn, prepared_receipts, now, True,
                )
            row = conn.execute(
                "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint "
                "FROM personal_daily_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            quota = _personal_quota_snapshot_locked(conn, owner, row[2])
            conn.commit()
            result = _reservation_result(row, quota)
            result["deducted"] = amount
            result["chargedPoints"] = amount
            result["reservedPoints"] = reserved_amount
            result["generationReceipts"] = prepared_receipts
            return result, None
        except sqlite3.IntegrityError:
            conn.rollback()
            # The event unique key is the final cross-process idempotency gate.
            row = conn.execute(
                "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint "
                "FROM personal_daily_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            if row and str(row[6]) == "settled":
                result = _reservation_result(
                    row,
                    _personal_quota_snapshot_locked(conn, owner, row[2]),
                    reused=True,
                )
                result["deducted"] = 0
                result["generationReceipts"] = []
                return result, None
            raise
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def release_personal_daily_points(member_id, reservation_id, now_ms=None):
    """Release one active freeze; duplicate releases are harmless."""
    owner = str(member_id or "")
    rid = str(reservation_id or "").strip()
    if not owner or not rid:
        return None, "reservation_not_found"
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint "
                "FROM personal_daily_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            if not row:
                conn.rollback()
                return None, "reservation_not_found"
            if str(row[6]) == "settled":
                quota = _personal_quota_snapshot_locked(conn, owner, row[2])
                conn.commit()
                return _reservation_result(row, quota, reused=True), "reservation_settled"
            reused = str(row[6]) == "released"
            if str(row[6]) == "active":
                conn.execute(
                    "UPDATE personal_daily_quota_reservations SET "
                    "status='released',updated_at=?,released_at=? "
                    "WHERE id=? AND member_id=? AND status='active'",
                    (now, now, rid, owner),
                )
            row = conn.execute(
                "SELECT id,member_id,quota_day,idempotency_key,points,feature,status,"
                "created_at,updated_at,settled_at,released_at,request_fingerprint "
                "FROM personal_daily_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            quota = _personal_quota_snapshot_locked(conn, owner, row[2])
            conn.commit()
            return _reservation_result(row, quota, reused=reused), None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def deduct_personal_daily_points(member_id, points, feature="", idempotency_key="", now_ms=None):
    """Compatibility wrapper implemented as reserve then settle.

    New billable endpoints must call ``reserve_personal_daily_points`` before
    touching an upstream provider and explicitly settle or release afterwards.
    """
    key = str(idempotency_key or "").strip()[:160] or f"legacy-deduct:{uuid.uuid4().hex}"
    reservation, error = reserve_personal_daily_points(
        member_id,
        points,
        feature=feature,
        idempotency_key=key,
        now_ms=now_ms,
    )
    if error or not reservation:
        return reservation, error
    if reservation.get("status") == "settled":
        result = dict(reservation.get("quota") or {})
        result.update({"deducted": 0, "reused": True})
        return result, None
    settled, error = settle_personal_daily_points(
        member_id,
        reservation.get("reservationId"),
        now_ms=now_ms,
    )
    if error or not settled:
        return settled, error
    result = dict(settled.get("quota") or {})
    result.update({
        "deducted": int(settled.get("deducted") or 0),
        "reused": bool(settled.get("reused")),
    })
    return result, None


def _generation_billing_scope_locked(conn, member_id):
    owner = str(member_id or "")
    row = conn.execute(
        "SELECT m.role,t.id,t.kind,t.plan,t.quota_mode "
        "FROM members m "
        "LEFT JOIN team_members tm ON tm.member_id=m.id AND tm.status='active' "
        "LEFT JOIN teams t ON t.id=tm.team_id AND t.status='active' "
        "WHERE m.id=? LIMIT 1",
        (owner,),
    ).fetchone()
    if not row:
        return {"type": "unconfigured", "error": "member_not_found"}
    role, team_id, team_kind, team_plan, quota_mode = row
    if team_id:
        # quota_mode is descriptive only. Never allow an external customer
        # team to gain an unlimited wallet by changing that column.
        if team_id == INTERNAL_TEAM_ID and team_kind == "internal":
            return {
                "type": "unlimited",
                "scopeType": "team",
                "scopeId": str(team_id),
                "plan": "team-pro",
                "quotaMode": "unlimited",
            }
        if str(team_plan or "") not in TEAM_SUBSCRIPTION_PLANS:
            return {"type": "unconfigured", "error": "team_plan_not_configured"}
        return {
            "type": "subscription",
            "scopeType": "team",
            "scopeId": str(team_id),
            "plan": str(team_plan),
            "quotaMode": "metered",
        }
    subscription = conn.execute(
        "SELECT plan FROM member_subscriptions "
        "WHERE member_id=? AND status='active' LIMIT 1",
        (owner,),
    ).fetchone()
    if subscription and str(subscription[0] or "") in PERSONAL_SUBSCRIPTION_PLANS:
        return {
            "type": "subscription",
            "scopeType": "member",
            "scopeId": owner,
            "plan": str(subscription[0]),
            "quotaMode": "metered",
        }
    if role == "user":
        return {
            "type": "daily",
            "scopeType": "member",
            "scopeId": owner,
            "plan": "personal",
            "quotaMode": "metered",
        }
    return {"type": "unconfigured", "error": "billing_scope_not_configured"}


def generation_billing_scope(member_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            return _generation_billing_scope_locked(conn, member_id)
        finally:
            conn.close()


def _subscription_quota_snapshot_locked(
    conn, scope_type, scope_id, quota_month,
):
    row = conn.execute(
        "SELECT plan,granted_points,purchased_points,used_points "
        "FROM subscription_monthly_quotas "
        "WHERE scope_type=? AND scope_id=? AND quota_month=?",
        (str(scope_type), str(scope_id), str(quota_month)),
    ).fetchone()
    if not row:
        return None
    reserved = int(conn.execute(
        "SELECT COALESCE(SUM(points),0) FROM subscription_quota_reservations "
        "WHERE scope_type=? AND scope_id=? AND quota_month=? AND status='active'",
        (str(scope_type), str(scope_id), str(quota_month)),
    ).fetchone()[0] or 0)
    plan = str(row[0] or "")
    granted = int(row[1] or 0)
    purchased = int(row[2] or 0)
    used = int(row[3] or 0)
    limit = granted + purchased
    remaining = max(0, limit - used - reserved)
    return {
        "type": "subscription",
        "period": "month",
        "month": str(quota_month),
        "plan": plan,
        "billingScope": {"type": str(scope_type), "id": str(scope_id)},
        "shared": str(scope_type) == "team",
        "granted": granted,
        "purchased": purchased,
        "limit": limit,
        "used": used,
        "reserved": reserved,
        "remaining": remaining,
        "available": remaining,
        "resetAt": _quota_reset_at_for_month(quota_month),
        "nonAccumulating": True,
    }


def _ensure_subscription_quota_row_locked(
    conn, scope_type, scope_id, quota_month, plan, now,
):
    clean_plan = str(plan or "")
    grant = SUBSCRIPTION_MONTHLY_POINTS.get(clean_plan)
    if not grant:
        raise ValueError("subscription_plan_not_configured")
    conn.execute(
        "INSERT OR IGNORE INTO subscription_monthly_quotas("
        "scope_type,scope_id,quota_month,plan,granted_points,purchased_points,"
        "used_points,updated_at) VALUES(?,?,?,?,?,0,0,?)",
        (
            str(scope_type), str(scope_id), str(quota_month), clean_plan,
            int(grant), int(now),
        ),
    )
    # A trusted mid-cycle upgrade increases the grant immediately. Downgrades
    # never revoke points already granted in the current month.
    conn.execute(
        "UPDATE subscription_monthly_quotas SET plan=?,"
        "granted_points=MAX(granted_points,?),updated_at=? "
        "WHERE scope_type=? AND scope_id=? AND quota_month=?",
        (
            clean_plan, int(grant), int(now), str(scope_type), str(scope_id),
            str(quota_month),
        ),
    )
    return _subscription_quota_snapshot_locked(
        conn, scope_type, scope_id, quota_month,
    )


def subscription_monthly_quota(member_id, now_ms=None):
    month, _reset_at = _china_quota_month(now_ms)
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            if runtime_config.is_read_only():
                scope = _generation_billing_scope_locked(conn, member_id)
                if scope.get("type") != "subscription":
                    return None
                existing = _subscription_quota_snapshot_locked(
                    conn, scope["scopeType"], scope["scopeId"], month,
                )
                if existing:
                    return existing
                granted = int(SUBSCRIPTION_MONTHLY_POINTS.get(scope["plan"], 0))
                return {
                    "type": "subscription",
                    "period": "month",
                    "month": str(month),
                    "plan": str(scope["plan"]),
                    "billingScope": {
                        "type": str(scope["scopeType"]),
                        "id": str(scope["scopeId"]),
                    },
                    "shared": str(scope["scopeType"]) == "team",
                    "granted": granted,
                    "purchased": 0,
                    "limit": granted,
                    "used": 0,
                    "reserved": 0,
                    "remaining": granted,
                    "available": granted,
                    "resetAt": _quota_reset_at_for_month(month),
                    "nonAccumulating": True,
                    "projected": True,
                }
            conn.execute("BEGIN IMMEDIATE")
            scope = _generation_billing_scope_locked(conn, member_id)
            if scope.get("type") != "subscription":
                conn.rollback()
                return None
            result = _ensure_subscription_quota_row_locked(
                conn,
                scope["scopeType"],
                scope["scopeId"],
                month,
                scope["plan"],
                now,
            )
            conn.commit()
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _subscription_reservation_result(row, quota, *, reused=False, retried=False):
    return {
        "reservationId": str(row[0] or ""),
        "billingScope": {"type": str(row[1] or ""), "id": str(row[2] or "")},
        "memberId": str(row[3] or ""),
        "quotaMonth": str(row[4] or ""),
        "plan": str(row[5] or ""),
        "idempotencyKey": str(row[6] or ""),
        "points": int(row[7] or 0),
        "feature": str(row[8] or ""),
        "status": str(row[9] or ""),
        "createdAt": int(row[10] or 0),
        "updatedAt": int(row[11] or 0),
        "settledAt": int(row[12] or 0) if row[12] is not None else None,
        "releasedAt": int(row[13] or 0) if row[13] is not None else None,
        "requestFingerprint": str(row[14] or ""),
        "billingType": "subscription",
        "reused": bool(reused),
        "retried": bool(retried),
        "quota": quota,
    }


def reserve_subscription_points(
    member_id,
    points,
    feature="",
    idempotency_key="",
    now_ms=None,
    request_fingerprint="",
):
    try:
        amount = int(points)
    except (TypeError, ValueError, OverflowError):
        amount = 0
    if amount <= 0:
        return None, "invalid_points"
    key = str(idempotency_key or "").strip()[:160]
    if not key:
        return None, "idempotency_key_required"
    clean_feature = str(feature or "生成任务")[:80]
    fingerprint = str(request_fingerprint or "").strip()[:128]
    owner = str(member_id or "")
    month, _reset_at = _china_quota_month(now_ms)
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            scope = _generation_billing_scope_locked(conn, owner)
            if scope.get("type") != "subscription":
                conn.rollback()
                return None, scope.get("error") or "subscription_required"
            scope_type, scope_id, plan = (
                scope["scopeType"], scope["scopeId"], scope["plan"],
            )
            _ensure_subscription_quota_row_locked(
                conn, scope_type, scope_id, month, plan, now,
            )
            previous = conn.execute(
                "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                "idempotency_key,points,feature,status,created_at,updated_at,"
                "settled_at,released_at,request_fingerprint "
                "FROM subscription_quota_reservations "
                "WHERE scope_type=? AND scope_id=? AND idempotency_key=?",
                (scope_type, scope_id, key),
            ).fetchone()
            if previous:
                if (
                    int(previous[7] or 0) != amount
                    or str(previous[8] or "") != clean_feature
                    or str(previous[14] or "") != fingerprint
                ):
                    conn.rollback()
                    return None, "idempotency_conflict"
                if str(previous[9] or "") == "released":
                    quota = _subscription_quota_snapshot_locked(
                        conn, scope_type, scope_id, month,
                    )
                    if not quota or int(quota["remaining"]) < amount:
                        conn.commit()
                        return quota, "insufficient_points"
                    conn.execute(
                        "UPDATE subscription_quota_reservations SET "
                        "member_id=?,quota_month=?,plan=?,status='active',updated_at=?,"
                        "settled_at=NULL,released_at=NULL WHERE id=? AND status='released'",
                        (owner, month, plan, now, previous[0]),
                    )
                    previous = conn.execute(
                        "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                        "idempotency_key,points,feature,status,created_at,updated_at,"
                        "settled_at,released_at,request_fingerprint "
                        "FROM subscription_quota_reservations WHERE id=?",
                        (previous[0],),
                    ).fetchone()
                    quota = _subscription_quota_snapshot_locked(
                        conn, scope_type, scope_id, month,
                    )
                    conn.commit()
                    return _subscription_reservation_result(
                        previous, quota, retried=True,
                    ), None
                quota = _subscription_quota_snapshot_locked(
                    conn, scope_type, scope_id, previous[4],
                )
                conn.commit()
                return _subscription_reservation_result(
                    previous, quota, reused=True,
                ), None

            settled_event = conn.execute(
                "SELECT quota_month,points,feature,created_at,member_id "
                "FROM subscription_quota_events WHERE scope_type=? AND scope_id=? "
                "AND idempotency_key=?",
                (scope_type, scope_id, key),
            ).fetchone()
            if settled_event:
                if int(settled_event[1] or 0) != amount:
                    conn.rollback()
                    return None, "idempotency_conflict"
                event_month = str(settled_event[0] or month)
                quota = _subscription_quota_snapshot_locked(
                    conn, scope_type, scope_id, event_month,
                )
                conn.commit()
                legacy_row = (
                    "", scope_type, scope_id, str(settled_event[4] or owner),
                    event_month, plan, key, amount,
                    str(settled_event[2] or clean_feature), "settled",
                    int(settled_event[3] or now), int(settled_event[3] or now),
                    int(settled_event[3] or now), None, "",
                )
                return _subscription_reservation_result(
                    legacy_row, quota, reused=True,
                ), None

            quota = _subscription_quota_snapshot_locked(
                conn, scope_type, scope_id, month,
            )
            if not quota or int(quota["remaining"]) < amount:
                conn.commit()
                return quota, "insufficient_points"
            reservation_id = "sq_" + uuid.uuid4().hex
            conn.execute(
                "INSERT INTO subscription_quota_reservations("
                "id,scope_type,scope_id,member_id,quota_month,plan,idempotency_key,"
                "points,feature,status,created_at,updated_at,settled_at,released_at,"
                "request_fingerprint) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,NULL,NULL,?)",
                (
                    reservation_id, scope_type, scope_id, owner, month, plan, key,
                    amount, clean_feature, now, now, fingerprint,
                ),
            )
            row = conn.execute(
                "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                "idempotency_key,points,feature,status,created_at,updated_at,"
                "settled_at,released_at,request_fingerprint "
                "FROM subscription_quota_reservations WHERE id=?",
                (reservation_id,),
            ).fetchone()
            quota = _subscription_quota_snapshot_locked(
                conn, scope_type, scope_id, month,
            )
            conn.commit()
            return _subscription_reservation_result(row, quota), None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def settle_subscription_points(
    member_id, reservation_id, now_ms=None, canvas_receipts=None, *,
    consumed_points=None,
):
    owner = str(member_id or "")
    rid = str(reservation_id or "").strip()
    if not owner or not rid:
        return None, "reservation_not_found"
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    prepared_receipts = _prepare_custom_canvas_generation_receipts(
        owner, canvas_receipts, now,
    ) if canvas_receipts else []
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                "idempotency_key,points,feature,status,created_at,updated_at,"
                "settled_at,released_at,request_fingerprint "
                "FROM subscription_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            if not row:
                conn.rollback()
                return None, "reservation_not_found"
            quota = _subscription_quota_snapshot_locked(
                conn, row[1], row[2], row[4],
            )
            status = str(row[9] or "")
            if status == "released":
                conn.commit()
                return _subscription_reservation_result(
                    row, quota, reused=True,
                ), "reservation_released"
            if status == "settled":
                conn.commit()
                result = _subscription_reservation_result(row, quota, reused=True)
                result["deducted"] = 0
                result["generationReceipts"] = []
                return result, None
            if status != "active":
                conn.rollback()
                return None, "invalid_reservation_status"
            reserved_amount = int(row[7] or 0)
            amount = (
                reserved_amount
                if consumed_points is None
                else int(consumed_points)
            )
            if amount <= 0 or amount > reserved_amount:
                conn.rollback()
                return quota, "invalid_consumed_points"
            if prepared_receipts and sum(
                int(receipt.get("points") or 0) for receipt in prepared_receipts
            ) != amount:
                conn.rollback()
                return quota, "receipt_points_mismatch"
            if not quota or int(quota["used"]) + amount > int(quota["limit"]):
                conn.rollback()
                return quota, "insufficient_points"
            conn.execute(
                "UPDATE subscription_monthly_quotas SET used_points=used_points+?,"
                "updated_at=? WHERE scope_type=? AND scope_id=? AND quota_month=?",
                (amount, now, row[1], row[2], row[4]),
            )
            conn.execute(
                "INSERT INTO subscription_quota_events("
                "id,scope_type,scope_id,member_id,quota_month,idempotency_key,"
                "points,feature,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex[:16], row[1], row[2], owner, row[4],
                    row[6], amount, row[8], now,
                ),
            )
            conn.execute(
                "UPDATE subscription_quota_reservations SET status='settled',"
                "updated_at=?,settled_at=?,released_at=NULL "
                "WHERE id=? AND member_id=? AND status='active'",
                (now, now, rid, owner),
            )
            if prepared_receipts:
                _insert_custom_canvas_generation_receipts_locked(
                    conn, prepared_receipts, now, True,
                )
            row = conn.execute(
                "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                "idempotency_key,points,feature,status,created_at,updated_at,"
                "settled_at,released_at,request_fingerprint "
                "FROM subscription_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            quota = _subscription_quota_snapshot_locked(
                conn, row[1], row[2], row[4],
            )
            conn.commit()
            result = _subscription_reservation_result(row, quota)
            result["deducted"] = amount
            result["chargedPoints"] = amount
            result["reservedPoints"] = reserved_amount
            result["generationReceipts"] = prepared_receipts
            return result, None
        except sqlite3.IntegrityError:
            conn.rollback()
            row = conn.execute(
                "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                "idempotency_key,points,feature,status,created_at,updated_at,"
                "settled_at,released_at,request_fingerprint "
                "FROM subscription_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            if row and str(row[9] or "") == "settled":
                result = _subscription_reservation_result(
                    row,
                    _subscription_quota_snapshot_locked(
                        conn, row[1], row[2], row[4],
                    ),
                    reused=True,
                )
                result["deducted"] = 0
                result["generationReceipts"] = []
                return result, None
            raise
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def release_subscription_points(member_id, reservation_id, now_ms=None):
    owner = str(member_id or "")
    rid = str(reservation_id or "").strip()
    if not owner or not rid:
        return None, "reservation_not_found"
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                "idempotency_key,points,feature,status,created_at,updated_at,"
                "settled_at,released_at,request_fingerprint "
                "FROM subscription_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            if not row:
                conn.rollback()
                return None, "reservation_not_found"
            quota = _subscription_quota_snapshot_locked(
                conn, row[1], row[2], row[4],
            )
            if str(row[9] or "") == "settled":
                conn.commit()
                return _subscription_reservation_result(
                    row, quota, reused=True,
                ), "reservation_settled"
            reused = str(row[9] or "") == "released"
            if str(row[9] or "") == "active":
                conn.execute(
                    "UPDATE subscription_quota_reservations SET status='released',"
                    "updated_at=?,released_at=? WHERE id=? AND member_id=? "
                    "AND status='active'",
                    (now, now, rid, owner),
                )
            row = conn.execute(
                "SELECT id,scope_type,scope_id,member_id,quota_month,plan,"
                "idempotency_key,points,feature,status,created_at,updated_at,"
                "settled_at,released_at,request_fingerprint "
                "FROM subscription_quota_reservations WHERE id=? AND member_id=?",
                (rid, owner),
            ).fetchone()
            quota = _subscription_quota_snapshot_locked(
                conn, row[1], row[2], row[4],
            )
            conn.commit()
            return _subscription_reservation_result(
                row, quota, reused=reused,
            ), None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def generation_quota(member_id, now_ms=None):
    scope = generation_billing_scope(member_id)
    if scope.get("type") == "unlimited":
        return {
            "type": "unlimited",
            "period": "none",
            "plan": scope.get("plan") or "team-pro",
            "billingScope": {
                "type": scope.get("scopeType"), "id": scope.get("scopeId"),
            },
            "shared": True,
            "limit": None,
            "used": 0,
            "reserved": 0,
            "remaining": None,
            "available": None,
            "resetAt": None,
            "nonAccumulating": False,
        }
    if scope.get("type") == "subscription":
        return subscription_monthly_quota(member_id, now_ms=now_ms)
    if scope.get("type") == "daily":
        return personal_daily_quota(member_id, now_ms=now_ms)
    return None


def reserve_generation_points(
    member_id,
    points,
    feature="",
    idempotency_key="",
    now_ms=None,
    request_fingerprint="",
):
    scope = generation_billing_scope(member_id)
    scope_type = scope.get("type")
    if scope_type == "unlimited":
        return {
            "reservationId": "",
            "status": "bypassed",
            "points": int(points or 0),
            "feature": str(feature or ""),
            "idempotencyKey": str(idempotency_key or ""),
            "billingType": "unlimited",
            "billingScope": {
                "type": scope.get("scopeType"), "id": scope.get("scopeId"),
            },
            "bypassed": True,
            "deducted": 0,
            "quota": generation_quota(member_id, now_ms=now_ms),
        }, None
    if scope_type == "subscription":
        return reserve_subscription_points(
            member_id,
            points,
            feature=feature,
            idempotency_key=idempotency_key,
            now_ms=now_ms,
            request_fingerprint=request_fingerprint,
        )
    if scope_type == "daily":
        result, error = reserve_personal_daily_points(
            member_id,
            points,
            feature=feature,
            idempotency_key=idempotency_key,
            now_ms=now_ms,
            request_fingerprint=request_fingerprint,
        )
        if result:
            result["billingType"] = "daily"
            result["billingScope"] = {"type": "member", "id": str(member_id)}
        return result, error
    return None, scope.get("error") or "billing_scope_not_configured"


def settle_generation_points(
    member_id, reservation_id, now_ms=None, canvas_receipts=None, *,
    consumed_points=None,
):
    rid = str(reservation_id or "")
    if rid.startswith("sq_"):
        return settle_subscription_points(
            member_id, rid, now_ms=now_ms, canvas_receipts=canvas_receipts,
            consumed_points=consumed_points,
        )
    return settle_personal_daily_points(
        member_id, rid, now_ms=now_ms, canvas_receipts=canvas_receipts,
        consumed_points=consumed_points,
    )


def release_generation_points(member_id, reservation_id, now_ms=None):
    rid = str(reservation_id or "")
    if rid.startswith("sq_"):
        return release_subscription_points(member_id, rid, now_ms=now_ms)
    return release_personal_daily_points(member_id, rid, now_ms=now_ms)


_VIDEO_GENERATION_TASK_COLUMNS = (
    "id,member_id,idempotency_key,request_fingerprint,reservation_id,points,"
    "feature,model,duration_seconds,provider_ref,provider,status,"
    "submit_response_json,poll_result_json,billing_json,error,created_at,"
    "updated_at,settled_at,released_at"
)


def _video_generation_json(raw):
    try:
        value = json.loads(str(raw or "{}"))
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _video_generation_task_public(row):
    if not row:
        return None
    return {
        "id": str(row[0] or ""),
        "memberId": str(row[1] or ""),
        "idempotencyKey": str(row[2] or ""),
        "requestFingerprint": str(row[3] or ""),
        "reservationId": str(row[4] or ""),
        "points": int(row[5] or 0),
        "feature": str(row[6] or ""),
        "model": str(row[7] or ""),
        "durationSeconds": int(row[8] or 0),
        "providerRef": str(row[9] or ""),
        "provider": str(row[10] or ""),
        "status": str(row[11] or ""),
        "submitResponse": _video_generation_json(row[12]),
        "pollResult": _video_generation_json(row[13]),
        "billing": _video_generation_json(row[14]),
        "error": str(row[15] or ""),
        "createdAt": int(row[16] or 0),
        "updatedAt": int(row[17] or 0),
        "settledAt": int(row[18] or 0) if row[18] is not None else None,
        "releasedAt": int(row[19] or 0) if row[19] is not None else None,
    }


def create_video_generation_billing_task(
    member_id,
    idempotency_key,
    request_fingerprint,
    points,
    feature,
    model,
    duration_seconds,
    now_ms=None,
):
    owner = str(member_id or "").strip()
    key = str(idempotency_key or "").strip()
    fingerprint = str(request_fingerprint or "").strip()
    if not owner:
        return None, "member_not_found", False
    if not key:
        return None, "idempotency_key_required", False
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                f"SELECT {_VIDEO_GENERATION_TASK_COLUMNS} "
                "FROM video_generation_billing_tasks "
                "WHERE member_id=? AND idempotency_key=?",
                (owner, key),
            ).fetchone()
            if row:
                task = _video_generation_task_public(row)
                conn.commit()
                if task.get("requestFingerprint") != fingerprint:
                    return task, "idempotency_conflict", False
                return task, None, False
            task_id = "vbt_" + uuid.uuid4().hex
            conn.execute(
                "INSERT INTO video_generation_billing_tasks("
                "id,member_id,idempotency_key,request_fingerprint,reservation_id,"
                "points,feature,model,duration_seconds,provider_ref,provider,status,"
                "submit_response_json,poll_result_json,billing_json,error,created_at,"
                "updated_at,settled_at,released_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,'','','preparing','{}','{}','{}','',?,?,NULL,NULL)",
                (
                    task_id, owner, key, fingerprint, "", int(points or 0),
                    str(feature or ""), str(model or ""),
                    int(duration_seconds or 0), now, now,
                ),
            )
            row = conn.execute(
                f"SELECT {_VIDEO_GENERATION_TASK_COLUMNS} "
                "FROM video_generation_billing_tasks WHERE id=?",
                (task_id,),
            ).fetchone()
            conn.commit()
            return _video_generation_task_public(row), None, True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def get_video_generation_billing_task(
    member_id, *, idempotency_key="", provider_ref="", task_id="",
):
    owner = str(member_id or "").strip()
    if not owner:
        return None
    where = "member_id=?"
    params = [owner]
    if provider_ref:
        where += " AND provider_ref=?"
        params.append(str(provider_ref))
    elif idempotency_key:
        where += " AND idempotency_key=?"
        params.append(str(idempotency_key))
    elif task_id:
        where += " AND id=?"
        params.append(str(task_id))
    else:
        return None
    row = _fetchone(
        f"SELECT {_VIDEO_GENERATION_TASK_COLUMNS} "
        f"FROM video_generation_billing_tasks WHERE {where}",
        tuple(params),
    )
    return _video_generation_task_public(row)


def attach_video_generation_reservation(
    task_id, member_id, reservation_id, billing, now_ms=None,
):
    owner = str(member_id or "").strip()
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    payload = json.dumps(billing or {}, ensure_ascii=False, separators=(",", ":"))
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            changed = conn.execute(
                "UPDATE video_generation_billing_tasks SET reservation_id=?,"
                "billing_json=?,status='reserved',updated_at=? "
                "WHERE id=? AND member_id=? AND status='preparing'",
                (str(reservation_id or ""), payload, now, str(task_id), owner),
            ).rowcount
            row = conn.execute(
                f"SELECT {_VIDEO_GENERATION_TASK_COLUMNS} "
                "FROM video_generation_billing_tasks WHERE id=? AND member_id=?",
                (str(task_id), owner),
            ).fetchone()
            conn.commit()
            return _video_generation_task_public(row), None if changed else "task_state_conflict"
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def mark_video_generation_submitted(
    task_id,
    member_id,
    provider_ref,
    provider,
    submit_response,
    now_ms=None,
):
    owner = str(member_id or "").strip()
    ref = str(provider_ref or "").strip()
    if not ref:
        return None, "provider_ref_required"
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    payload = json.dumps(
        submit_response or {}, ensure_ascii=False, separators=(",", ":"),
    )
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            changed = conn.execute(
                "UPDATE video_generation_billing_tasks SET provider_ref=?,provider=?,"
                "submit_response_json=?,status='submitted',updated_at=? "
                "WHERE id=? AND member_id=? AND status='reserved'",
                (ref, str(provider or ""), payload, now, str(task_id), owner),
            ).rowcount
            row = conn.execute(
                f"SELECT {_VIDEO_GENERATION_TASK_COLUMNS} "
                "FROM video_generation_billing_tasks WHERE id=? AND member_id=?",
                (str(task_id), owner),
            ).fetchone()
            conn.commit()
            return _video_generation_task_public(row), None if changed else "task_state_conflict"
        except sqlite3.IntegrityError:
            conn.rollback()
            return None, "provider_ref_conflict"
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def update_video_generation_billing_task(
    task_id,
    member_id,
    status,
    *,
    poll_result=None,
    billing=None,
    error="",
    settled=False,
    released=False,
    now_ms=None,
):
    owner = str(member_id or "").strip()
    clean_status = str(status or "").strip()
    if clean_status not in {
        "preparing", "reserved", "submitted", "running", "succeeded",
        "failed", "cancelled", "interrupted",
    }:
        return None, "invalid_task_status"
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    assignments = ["status=?", "error=?", "updated_at=?"]
    params = [clean_status, str(error or ""), now]
    if poll_result is not None:
        assignments.append("poll_result_json=?")
        params.append(json.dumps(
            poll_result or {}, ensure_ascii=False, separators=(",", ":"),
        ))
    if billing is not None:
        assignments.append("billing_json=?")
        params.append(json.dumps(
            billing or {}, ensure_ascii=False, separators=(",", ":"),
        ))
    if settled:
        assignments.append("settled_at=COALESCE(settled_at,?)")
        params.append(now)
    if released:
        assignments.append("released_at=COALESCE(released_at,?)")
        params.append(now)
    params.extend([str(task_id), owner])
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            changed = conn.execute(
                "UPDATE video_generation_billing_tasks SET "
                + ",".join(assignments)
                + " WHERE id=? AND member_id=?",
                tuple(params),
            ).rowcount
            row = conn.execute(
                f"SELECT {_VIDEO_GENERATION_TASK_COLUMNS} "
                "FROM video_generation_billing_tasks WHERE id=? AND member_id=?",
                (str(task_id), owner),
            ).fetchone()
            conn.commit()
            return _video_generation_task_public(row), None if changed else "task_not_found"
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def list_stale_video_generation_billing_tasks(cutoff_ms):
    rows = _fetchall(
        f"SELECT {_VIDEO_GENERATION_TASK_COLUMNS} "
        "FROM video_generation_billing_tasks "
        "WHERE status IN ('preparing','reserved') AND updated_at<? "
        "ORDER BY updated_at ASC",
        (int(cutoff_ms),),
    )
    return [_video_generation_task_public(row) for row in rows]


def activate_personal_subscription_plan(
    member_id, plan, *, activated_by=None, now_ms=None,
):
    """Trusted entitlement hook; deliberately not exposed as an HTTP route."""
    clean_plan = str(plan or "").strip()
    if clean_plan not in PERSONAL_SUBSCRIPTION_PLANS:
        return None, "invalid_plan"
    owner = str(member_id or "")
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    month, _reset_at = _china_quota_month(now)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            member = conn.execute(
                "SELECT role FROM members WHERE id=?", (owner,),
            ).fetchone()
            if not member or member[0] != "user":
                conn.rollback()
                return None, "member_not_eligible"
            if conn.execute(
                "SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id "
                "WHERE tm.member_id=? AND tm.status='active' AND t.status='active'",
                (owner,),
            ).fetchone():
                conn.rollback()
                return None, "already_in_team"
            conn.execute(
                "INSERT INTO member_subscriptions("
                "member_id,plan,status,activated_at,updated_at,activated_by"
                ") VALUES(?,?,'active',?,?,?) "
                "ON CONFLICT(member_id) DO UPDATE SET plan=excluded.plan,"
                "status='active',updated_at=excluded.updated_at,"
                "activated_by=excluded.activated_by",
                (owner, clean_plan, now, now, str(activated_by or "") or None),
            )
            result = _ensure_subscription_quota_row_locked(
                conn, "member", owner, month, clean_plan, now,
            )
            conn.commit()
            return result, None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def grant_subscription_addon_points(
    member_id,
    points,
    entitlement_ref,
    *,
    activated_by=None,
    now_ms=None,
):
    """Trusted, idempotent add-on hook for a verified payment/entitlement flow."""
    try:
        amount = int(points)
    except (TypeError, ValueError, OverflowError):
        amount = 0
    reference = str(entitlement_ref or "").strip()[:180]
    if amount <= 0:
        return None, "invalid_points"
    if not reference:
        return None, "entitlement_ref_required"
    month, _reset_at = _china_quota_month(now_ms)
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            scope = _generation_billing_scope_locked(conn, member_id)
            if scope.get("type") != "subscription":
                conn.rollback()
                return None, "subscription_required"
            quota = _ensure_subscription_quota_row_locked(
                conn,
                scope["scopeType"],
                scope["scopeId"],
                month,
                scope["plan"],
                now,
            )
            previous = conn.execute(
                "SELECT points FROM subscription_quota_topups "
                "WHERE scope_type=? AND scope_id=? AND entitlement_ref=?",
                (scope["scopeType"], scope["scopeId"], reference),
            ).fetchone()
            if previous:
                if int(previous[0] or 0) != amount:
                    conn.rollback()
                    return None, "idempotency_conflict"
                conn.commit()
                quota["reused"] = True
                return quota, None
            conn.execute(
                "INSERT INTO subscription_quota_topups("
                "id,scope_type,scope_id,quota_month,points,entitlement_ref,"
                "activated_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex[:16], scope["scopeType"], scope["scopeId"],
                    month, amount, reference,
                    str(activated_by or "") or None, now,
                ),
            )
            conn.execute(
                "UPDATE subscription_monthly_quotas SET "
                "purchased_points=purchased_points+?,updated_at=? "
                "WHERE scope_type=? AND scope_id=? AND quota_month=?",
                (
                    amount, now, scope["scopeType"], scope["scopeId"], month,
                ),
            )
            quota = _subscription_quota_snapshot_locked(
                conn, scope["scopeType"], scope["scopeId"], month,
            )
            conn.commit()
            quota["reused"] = False
            return quota, None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def list_team_members(team_id):
    if not team_id:
        return []
    rows = _fetchall(
        "SELECT m.id,m.name,m.username,m.pin_hash,m.role,m.parent_id,m.avatar_url,m.created_at "
        "FROM team_members tm JOIN members m ON m.id=tm.member_id "
        "WHERE tm.team_id=? AND tm.status='active' "
        "ORDER BY CASE tm.team_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,m.created_at",
        (team_id,),
    )
    return [member_public(row) for row in rows]


def team_role_for(member_id):
    team = member_team(member_id)
    return team["role"] if team else None


def update_team_member_role(team_id, member_id, team_role):
    clean_role = team_role if team_role in {"admin", "creator"} else "creator"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            current = conn.execute(
                "SELECT team_role FROM team_members WHERE team_id=? AND member_id=? AND status='active'",
                (team_id, member_id),
            ).fetchone()
            if not current:
                return None, "not_found"
            if current[0] == "owner":
                return None, "owner_locked"
            conn.execute(
                "UPDATE team_members SET team_role=? WHERE team_id=? AND member_id=?",
                (clean_role, team_id, member_id),
            )
            conn.execute(
                "UPDATE members SET role=? WHERE id=? AND role IN ('user','editor')",
                ("editor", member_id),
            )
            conn.commit()
        finally:
            conn.close()
    return member_public(get_member(member_id)), None


def add_member(name, username, pin, role, parent_id=None, team_id=None, team_role=None, added_by=None):
    return add_member_with_hash(
        name, username, hash_pin(pin), role, parent_id,
        team_id=team_id, team_role=team_role, added_by=added_by,
    )


def add_member_with_hash(
    name, username, pin_hash, role, parent_id=None,
    *, team_id=None, team_role=None, added_by=None,
):
    username = normalize_username(username)
    username_key = canonical_username(username)
    if not username_key:
        raise ValueError("username_required")
    mid = uuid.uuid4().hex[:10]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            # 跨进程也串行化「检查 canonical key + 写入」，避免
            # Alice/alice 在并发注册时绕过查询层约束。
            conn.execute("BEGIN IMMEDIATE")
            now = int(time.time() * 1000)
            if conn.execute(
                "SELECT 1 FROM members WHERE username_key=? LIMIT 1",
                (username_key,),
            ).fetchone() or conn.execute(
                "SELECT 1 FROM member_requests WHERE username_key=? AND status='pending' LIMIT 1",
                (username_key,),
            ).fetchone():
                raise sqlite3.IntegrityError("username_exists")
            conn.execute(
                "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (mid, name, username, username_key, pin_hash, role, parent_id, now),
            )
            if team_id:
                conn.execute(
                    "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                    "VALUES(?,?,?,?,?,?)",
                    (
                        str(team_id), mid, str(team_role or "creator"), "active",
                        now, str(added_by or "") or None,
                    ),
                )
            conn.commit()
        finally:
            conn.close()
    return get_member(mid)


def get_member(mid):
    return _fetchone("SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members WHERE id=?", (mid,))


def get_member_by_username(username):
    clean = normalize_username(username)
    key = canonical_username(clean)
    if not key:
        return None
    # 旧库可能已有 Alice/alice 碰撞：精确大小写优先，否则稳定返回
    # 最早账号。新注册会拦截继续制造这类碰撞。
    return _fetchone(
        "SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at "
        "FROM members WHERE username_key=? "
        "ORDER BY CASE WHEN trim(username)=? THEN 0 ELSE 1 END,created_at,id LIMIT 1",
        (key, clean),
    )


def list_members():
    rows = _fetchall("SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members ORDER BY created_at")
    return [member_public(r) for r in rows]


def update_member(mid, name=None, username=None, role=None, pin=None, parent_id=None, avatar_url=None):
    sets, vals = [], []
    if name is not None:
        sets.append("name=?"); vals.append(name)
    if username is not None:
        username = normalize_username(username)
        username_key = canonical_username(username)
        if not username_key:
            raise ValueError("username_required")
        sets.extend(("username=?", "username_key=?")); vals.extend((username, username_key))
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
                if username is not None:
                    conn.execute("BEGIN IMMEDIATE")
                    if conn.execute(
                        "SELECT 1 FROM members WHERE username_key=? AND id<>? LIMIT 1",
                        (username_key, mid),
                    ).fetchone() or conn.execute(
                        "SELECT 1 FROM member_requests WHERE username_key=? AND status='pending' LIMIT 1",
                        (username_key,),
                    ).fetchone():
                        raise sqlite3.IntegrityError("username_exists")
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
            conn.execute("DELETE FROM team_join_requests WHERE member_id=?", (mid,))
            conn.execute("DELETE FROM team_members WHERE member_id=?", (mid,))
            conn.execute("DELETE FROM team_suppliers WHERE supplier_parent_id=?", (mid,))
            conn.execute("DELETE FROM members WHERE id=?", (mid,))
            conn.commit()
        finally:
            conn.close()


def member_public(row):
    item = _member_public(row)
    team = member_team(item["id"])
    item["team"] = team
    item["teamId"] = team["id"] if team else None
    item["teamRole"] = team["role"] if team else None
    item["entitlements"] = member_entitlements(item["id"], item["role"])
    quota = generation_quota(item["id"])
    item["plan"] = team["plan"] if team else str((quota or {}).get("plan") or "personal")
    item["generationQuota"] = quota
    if quota:
        item["pointsLimit"] = quota.get("limit")
        item["pointsUsed"] = quota.get("used")
        item["pointsReserved"] = quota.get("reserved")
        item["pointsRemaining"] = quota.get("remaining")
        item["pointsResetAt"] = quota.get("resetAt")
    if quota and quota.get("type") == "daily":
        # Keep both the compact display values and the auditable object so
        # older clients can adopt this without a schema migration.
        item["dailyPoints"] = quota["limit"]
        item["dailyPointsUsed"] = quota["used"]
        item["dailyPointsReserved"] = quota["reserved"]
        item["dailyPointsRemaining"] = quota["remaining"]
        item["dailyPointsResetAt"] = quota["resetAt"]
        item["dailyQuota"] = quota
    return item


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
    username = normalize_username(username)
    username_key = canonical_username(username)
    if not username_key:
        raise ValueError("username_required")
    rid = uuid.uuid4().hex[:10]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute(
                "SELECT 1 FROM members WHERE username_key=? LIMIT 1",
                (username_key,),
            ).fetchone() or conn.execute(
                "SELECT 1 FROM member_requests WHERE username_key=? AND status='pending' LIMIT 1",
                (username_key,),
            ).fetchone():
                raise sqlite3.IntegrityError("username_exists")
            conn.execute(
                "INSERT INTO member_requests(id,name,username,username_key,pin_hash,role,status,message,created_at,reviewed_at,reviewed_by) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    rid, name, username, username_key, hash_pin(pin), role,
                    "pending", message, int(time.time() * 1000), None, None,
                ),
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
    key = canonical_username(username)
    if not key:
        return False
    row = _fetchone(
        "SELECT id FROM member_requests WHERE username_key=? AND status='pending'",
        (key,),
    )
    return bool(row)


# ---------- 团队与加入申请 ----------
def list_joinable_teams():
    rows = _fetchall(
        "SELECT t.id,t.name,t.kind,t.plan,"
        "COUNT(tm.member_id) FROM teams t "
        "LEFT JOIN team_members tm ON tm.team_id=t.id AND tm.status='active' "
        "WHERE t.status='active' GROUP BY t.id,t.name,t.kind,t.plan "
        "ORDER BY t.kind='internal' DESC,t.created_at"
    )
    return [
        {
            "id": row[0], "name": row[1], "kind": row[2], "plan": row[3],
            "seatLimit": None if row[2] == "internal" else TEAM_SEAT_LIMITS.get(row[3], TEAM_SEAT_LIMITS["team"]),
            "activeMembers": int(row[4] or 0),
            "seatsAvailable": None if row[2] == "internal" else max(0, TEAM_SEAT_LIMITS.get(row[3], TEAM_SEAT_LIMITS["team"]) - int(row[4] or 0)),
        }
        for row in rows
    ]


def team_for_name(name):
    clean = re.sub(r"\s+", " ", str(name or "")).strip()
    if not clean:
        return None
    row = _fetchone(
        "SELECT id,name,kind,status,plan,quota_mode FROM teams "
        "WHERE status='active' AND lower(name)=lower(?)",
        (clean,),
    )
    if not row:
        return None
    return {
        "id": row[0], "name": row[1], "kind": row[2], "status": row[3],
        "plan": row[4], "quotaMode": row[5],
    }


def activate_customer_team_plan(member_id, team_name, plan="team"):
    """Atomically create a paid customer team after an external verifier succeeds.

    This intentionally has no public self-service endpoint: a future billing or
    administrator flow may call it only after entitlement verification.
    """
    clean_name = re.sub(r"\s+", " ", str(team_name or "")).strip()[:80]
    clean_plan = str(plan or "team").strip()
    if not clean_name:
        return None, "team_name_required"
    if clean_plan not in {"team", "team-pro"}:
        return None, "invalid_plan"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            member = conn.execute(
                "SELECT role FROM members WHERE id=?", (member_id,),
            ).fetchone()
            if not member or member[0] != "user":
                conn.rollback()
                return None, "member_not_eligible"
            if conn.execute(
                "SELECT 1 FROM team_members WHERE member_id=? AND status='active' LIMIT 1",
                (member_id,),
            ).fetchone():
                conn.rollback()
                return None, "already_in_team"
            if conn.execute(
                "SELECT 1 FROM teams WHERE lower(name)=lower(?) LIMIT 1",
                (clean_name,),
            ).fetchone():
                conn.rollback()
                return None, "team_name_exists"
            now = int(time.time() * 1000)
            team_id = "team-" + uuid.uuid4().hex[:16]
            conn.execute(
                "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    team_id, clean_name, "customer-" + uuid.uuid4().hex[:16],
                    "customer", "active", clean_plan, "metered", now, member_id,
                ),
            )
            conn.execute(
                "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                "VALUES(?,?,?,?,?,?)",
                (team_id, member_id, "owner", "active", now, member_id),
            )
            conn.execute("UPDATE members SET role='editor' WHERE id=?", (member_id,))
            conn.commit()
        finally:
            conn.close()
    return member_public(get_member(member_id)), None


def rename_team(member_id, team_name):
    """Rename an external team. Only its owner may do so; ACG is immutable."""
    clean_name = re.sub(r"\s+", " ", str(team_name or "")).strip()[:80]
    if not clean_name:
        return None, "team_name_required"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT t.id,t.kind,tm.team_role FROM team_members tm "
                "JOIN teams t ON t.id=tm.team_id "
                "WHERE tm.member_id=? AND tm.status='active' AND t.status='active'",
                (member_id,),
            ).fetchone()
            if not row or row[2] != "owner":
                conn.rollback()
                return None, "forbidden"
            if row[1] == "internal":
                conn.rollback()
                return None, "internal_team_immutable"
            if conn.execute(
                "SELECT 1 FROM teams WHERE id<>? AND lower(name)=lower(?) LIMIT 1",
                (row[0], clean_name),
            ).fetchone():
                conn.rollback()
                return None, "team_name_exists"
            conn.execute("UPDATE teams SET name=? WHERE id=?", (clean_name, row[0]))
            conn.commit()
        finally:
            conn.close()
    return member_team(member_id), None


def add_team_join_request(member_id, team_name, message=""):
    team = team_for_name(team_name)
    if not team:
        return None, "team_not_found"
    if member_team(member_id):
        return None, "already_in_team"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            existing = conn.execute(
                "SELECT id,status FROM team_join_requests WHERE team_id=? AND member_id=? "
                "ORDER BY created_at DESC LIMIT 1",
                (team["id"], member_id),
            ).fetchone()
            if existing and existing[1] == "pending":
                return None, "already_pending"
            rid = uuid.uuid4().hex[:12]
            now = int(time.time() * 1000)
            conn.execute(
                "INSERT INTO team_join_requests(id,team_id,member_id,status,message,created_at) "
                "VALUES(?,?,?,?,?,?)",
                (
                    rid, team["id"], member_id, "pending",
                    re.sub(r"\s+", " ", str(message or "")).strip()[:240], now,
                ),
            )
            conn.commit()
            return {
                "id": rid, "teamId": team["id"], "teamName": team["name"],
                "memberId": member_id, "status": "pending", "createdAt": now,
            }, None
        finally:
            conn.close()


def can_manage_team(member_id, team_id):
    row = _fetchone(
        "SELECT team_role FROM team_members "
        "WHERE member_id=? AND team_id=? AND status='active'",
        (member_id, team_id),
    )
    return bool(row and row[0] in {"owner", "admin"})


def list_team_join_requests(reviewer_id, status="pending"):
    team = member_team(reviewer_id)
    if not team or team["role"] not in {"owner", "admin"}:
        raise PermissionError("forbidden")
    params = [team["id"]]
    status_sql = ""
    if status:
        status_sql = " AND r.status=?"
        params.append(status)
    rows = _fetchall(
        "SELECT r.id,r.team_id,t.name,r.member_id,m.name,m.username,r.status,r.message,"
        "r.created_at,r.reviewed_at,r.reviewed_by "
        "FROM team_join_requests r "
        "JOIN teams t ON t.id=r.team_id JOIN members m ON m.id=r.member_id "
        "WHERE r.team_id=?" + status_sql + " ORDER BY r.created_at DESC",
        tuple(params),
    )
    return [{
        "id": row[0], "teamId": row[1], "teamName": row[2],
        "memberId": row[3], "memberName": row[4], "username": row[5],
        "status": row[6], "message": row[7] or "", "createdAt": row[8],
        "reviewedAt": row[9], "reviewedBy": row[10],
    } for row in rows]


def review_team_join_request(request_id, reviewer_id, approve):
    _ensure_db()
    reviewed_member_id = None
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,team_id,member_id,status FROM team_join_requests WHERE id=?",
                (request_id,),
            ).fetchone()
            if not row:
                return None, "not_found"
            if row[3] != "pending":
                return None, "not_pending"
            manager = conn.execute(
                "SELECT team_role FROM team_members "
                "WHERE team_id=? AND member_id=? AND status='active'",
                (row[1], reviewer_id),
            ).fetchone()
            if not manager or manager[0] not in {"owner", "admin"}:
                return None, "forbidden"
            now = int(time.time() * 1000)
            next_status = "approved" if approve else "rejected"
            if approve:
                if conn.execute(
                    "SELECT 1 FROM team_members WHERE member_id=? AND status='active'",
                    (row[2],),
                ).fetchone():
                    return None, "already_in_team"
                team_row = conn.execute(
                    "SELECT kind,plan FROM teams WHERE id=? AND status='active'",
                    (row[1],),
                ).fetchone()
                if not team_row:
                    return None, "not_found"
                if team_row[0] != "internal":
                    limit = TEAM_SEAT_LIMITS.get(team_row[1], TEAM_SEAT_LIMITS["team"])
                    count = conn.execute(
                        "SELECT COUNT(*) FROM team_members WHERE team_id=? AND status='active'",
                        (row[1],),
                    ).fetchone()[0]
                    if int(count or 0) >= limit:
                        return None, "team_full"
                conn.execute(
                    "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                    "VALUES(?,?,?,?,?,?)",
                    (row[1], row[2], "creator", "active", now, reviewer_id),
                )
                # 加入团队后仍是创作成员；平台管理员角色不会在这里被授予。
                conn.execute(
                    "UPDATE members SET role='editor' WHERE id=? AND role='user'",
                    (row[2],),
                )
            conn.execute(
                "UPDATE team_join_requests SET status=?,reviewed_at=?,reviewed_by=? WHERE id=?",
                (next_status, now, reviewer_id, request_id),
            )
            conn.commit()
            reviewed_member_id = row[2]
        finally:
            conn.close()
    return member_public(get_member(reviewed_member_id)), None


def list_platform_account_summaries():
    """Read-only platform-level account summary for internal-team managers.

    It intentionally returns identity, plan and team metadata only. Password
    hashes, reset tokens, assets, account credentials and supplier details stay
    behind their dedicated APIs.
    """
    personal_rows = _fetchall(
        "SELECT m.id,m.name,m.username,m.created_at FROM members m "
        "WHERE m.role='user' AND NOT EXISTS("
        "SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id "
        "WHERE tm.member_id=m.id AND tm.status='active' AND t.status='active'"
        ") ORDER BY m.created_at DESC"
    )
    owner_rows = _fetchall(
        "SELECT m.id,m.name,m.username,m.created_at,t.id,t.name,t.plan,t.kind "
        "FROM team_members tm JOIN members m ON m.id=tm.member_id "
        "JOIN teams t ON t.id=tm.team_id WHERE tm.status='active' AND t.status='active' "
        "AND tm.team_role='owner' ORDER BY t.created_at DESC"
    )
    return {
        "personal": [
            {
                "id": row[0], "name": row[1], "username": row[2],
                "createdAt": row[3], "category": "personal", "plan": "personal",
            }
            for row in personal_rows
        ],
        "teamOwners": [
            {
                "id": row[0], "name": row[1], "username": row[2], "createdAt": row[3],
                "category": "team_owner", "teamId": row[4], "teamName": row[5],
                "plan": row[6], "teamKind": row[7],
            }
            for row in owner_rows
        ],
    }


def team_account_ids(team_id):
    if not team_id:
        return set()
    rows = _fetchall("SELECT account_id FROM team_accounts WHERE team_id=?", (team_id,))
    return {str(row[0]) for row in rows}


def team_member_ids(team_id):
    if not team_id:
        return set()
    rows = _fetchall(
        "SELECT tm.member_id FROM team_members tm JOIN teams t ON t.id=tm.team_id "
        "WHERE tm.team_id=? AND tm.status='active' AND t.status='active'",
        (team_id,),
    )
    return {str(row[0]) for row in rows}


def assign_team_accounts(team_id, account_ids, added_by=None):
    if not team_id:
        return
    ids = sorted({str(account_id) for account_id in (account_ids or []) if str(account_id)})
    if not ids:
        return
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            now = int(time.time() * 1000)
            for account_id in ids:
                conn.execute(
                    "INSERT OR IGNORE INTO team_accounts(team_id,account_id,created_at,added_by) "
                    "VALUES(?,?,?,?)",
                    (team_id, account_id, now, added_by),
                )
            conn.commit()
        finally:
            conn.close()


def _supplier_access_context_locked(conn, member_id, role=None, parent_id=None):
    """Resolve one supplier identity to an active team without trusting callers.

    A supplier login is useful only when its real database role and parent chain
    terminate at an explicitly mapped supplier parent.  This is deliberately
    fail closed: historical accounts that have not been migrated into
    ``team_suppliers`` see no tenant data and cannot mutate it.
    """
    clean_member_id = str(member_id or "")
    if not clean_member_id:
        return None
    row = conn.execute(
        "SELECT role,parent_id FROM members WHERE id=?",
        (clean_member_id,),
    ).fetchone()
    if not row or row[0] not in {"supplier_parent", "supplier_child"}:
        return None
    actual_role = str(row[0])
    requested_role = "supplier_parent" if role == "supplier" else str(role or actual_role)
    if requested_role not in {"supplier_parent", "supplier_child"} or requested_role != actual_role:
        return None
    if actual_role == "supplier_parent":
        supplier_parent_id = clean_member_id
    else:
        supplier_parent_id = str(row[1] or "")
        if not supplier_parent_id:
            return None
        if parent_id is not None and str(parent_id or "") != supplier_parent_id:
            return None
    team = conn.execute(
        "SELECT ts.team_id FROM team_suppliers ts "
        "JOIN teams t ON t.id=ts.team_id AND t.status='active' "
        "JOIN members p ON p.id=ts.supplier_parent_id AND p.role='supplier_parent' "
        "WHERE ts.supplier_parent_id=?",
        (supplier_parent_id,),
    ).fetchone()
    if not team:
        return None
    return {
        "memberId": clean_member_id,
        "role": actual_role,
        "parentId": supplier_parent_id,
        "teamId": str(team[0]),
    }


def supplier_access_context(member_id, role=None, parent_id=None):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            return _supplier_access_context_locked(conn, member_id, role, parent_id)
        finally:
            conn.close()


def supplier_team_id(member_id, role=None, parent_id=None):
    context = supplier_access_context(member_id, role, parent_id)
    return context["teamId"] if context else None


def _supplier_account_allowed_locked(conn, context, account_id):
    if not context or not str(account_id or ""):
        return False
    clean_account_id = str(account_id)
    mapped = conn.execute(
        "SELECT 1 FROM team_accounts WHERE team_id=? AND account_id=?",
        (context["teamId"], clean_account_id),
    ).fetchone()
    if not mapped:
        return False
    if context["role"] == "supplier_parent":
        return True
    return bool(conn.execute(
        "SELECT 1 FROM supplier_account_bindings "
        "WHERE parent_id=? AND child_id=? AND account_id=?",
        (context["parentId"], context["memberId"], clean_account_id),
    ).fetchone())


def _supplier_asset_allowed_locked(conn, context, item):
    return bool(
        isinstance(item, dict)
        and _supplier_account_allowed_locked(conn, context, item.get("accountId"))
    )


def _supplier_parent_ids_for_context_locked(conn, context):
    if not context:
        return set()
    return {
        str(row[0]) for row in conn.execute(
            "SELECT ts.supplier_parent_id FROM team_suppliers ts "
            "JOIN members m ON m.id=ts.supplier_parent_id AND m.role='supplier_parent' "
            "WHERE ts.team_id=?",
            (context["teamId"],),
        ).fetchall()
    }


def _supplier_member_row_locked(conn, context, target_id, include_all=True):
    if not context:
        return None
    row = conn.execute(
        "SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at "
        "FROM members WHERE id=?",
        (str(target_id or ""),),
    ).fetchone()
    if not row or row[4] not in {"supplier_parent", "supplier_child"}:
        return None
    allowed_parents = (
        _supplier_parent_ids_for_context_locked(conn, context)
        if include_all else {context["parentId"]}
    )
    if row[4] == "supplier_parent":
        return row if row[0] in allowed_parents else None
    return row if row[5] in allowed_parents else None


def supplier_parent_ids_for_team(team_id):
    if not team_id:
        return set()
    rows = _fetchall(
        "SELECT supplier_parent_id FROM team_suppliers WHERE team_id=?",
        (team_id,),
    )
    return {str(row[0]) for row in rows}


def team_supplier_accounts(team_id):
    """Return login identities for supplier administrators owned by a team.

    Password hashes are deliberately never returned. Team managers may set a
    new password through a separate endpoint when the original is unknown.
    """
    if not team_id:
        return []
    rows = _fetchall(
        "SELECT m.id,m.name,m.username,m.created_at "
        "FROM team_suppliers ts JOIN members m ON m.id=ts.supplier_parent_id "
        "WHERE ts.team_id=? AND m.role='supplier_parent' ORDER BY m.created_at",
        (team_id,),
    )
    return [
        {
            "id": row[0],
            "name": row[1],
            "username": row[2],
            "createdAt": row[3],
        }
        for row in rows
    ]


def provision_team_supplier_admin(team_id, added_by=None):
    """Idempotently provision one supplier administrator for an external team.

    This is intentionally an explicit management operation.  The project does
    not yet have a server-side purchase/plan-activation workflow, so a pricing
    preview must never call this implicitly.  The bootstrap password is only
    returned by the first successful transaction; SQLite stores its hash only.
    """
    clean_team_id = str(team_id or "").strip()
    if not clean_team_id:
        return None, "not_found"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            team = conn.execute(
                "SELECT id,name,slug,kind,status,plan FROM teams WHERE id=?",
                (clean_team_id,),
            ).fetchone()
            if not team:
                conn.rollback()
                return None, "not_found"

            existing = conn.execute(
                "SELECT m.id,m.name,m.username,m.created_at "
                "FROM team_suppliers ts JOIN members m ON m.id=ts.supplier_parent_id "
                "WHERE ts.team_id=? AND m.role='supplier_parent' "
                "ORDER BY m.created_at,m.id LIMIT 1",
                (clean_team_id,),
            ).fetchone()
            # The internal ACG relationship is a protected migration invariant.
            # Never synthesize or replace its supplier account here.
            if team[3] == "internal" or clean_team_id == INTERNAL_TEAM_ID:
                if existing:
                    conn.commit()
                    return {
                        "created": False,
                        "account": {
                            "id": existing[0], "name": existing[1],
                            "username": existing[2], "createdAt": existing[3],
                        },
                    }, None
                conn.rollback()
                return None, "internal_team_protected"
            if team[3] != "customer":
                conn.rollback()
                return None, "team_not_eligible"
            if team[4] != "active":
                conn.rollback()
                return None, "team_inactive"
            if team[5] not in TEAM_SUPPLIER_ELIGIBLE_PLANS:
                conn.rollback()
                return None, "plan_not_eligible"
            if existing:
                conn.commit()
                return {
                    "created": False,
                    "account": {
                        "id": existing[0], "name": existing[1],
                        "username": existing[2], "createdAt": existing[3],
                    },
                }, None

            slug = re.sub(r"[^a-z0-9]+", "-", str(team[2] or "").casefold()).strip("-")
            if not slug:
                slug = re.sub(r"[^a-z0-9]+", "-", clean_team_id.casefold()).strip("-")
            slug = (slug or hashlib.sha256(clean_team_id.encode()).hexdigest()[:12])[:36]
            username_base = f"supplier-{slug}"
            username = ""
            for index in range(10_000):
                candidate = username_base if index == 0 else f"{username_base}-{index + 1}"
                key = canonical_username(candidate)
                occupied = conn.execute(
                    "SELECT 1 FROM members WHERE username_key=? LIMIT 1",
                    (key,),
                ).fetchone() or conn.execute(
                    "SELECT 1 FROM member_requests "
                    "WHERE username_key=? AND status='pending' LIMIT 1",
                    (key,),
                ).fetchone()
                if not occupied:
                    username = candidate
                    break
            if not username:
                raise RuntimeError("supplier_username_exhausted")

            now = int(time.time() * 1000)
            member_id = uuid.uuid4().hex[:10]
            temporary_password = secrets.token_urlsafe(18)
            display_name = f"{str(team[1] or '').strip() or '团队'} 供应商管理员"
            conn.execute(
                "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    member_id, display_name, username, canonical_username(username),
                    hash_pin(temporary_password), "supplier_parent", None, now,
                ),
            )
            conn.execute(
                "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                "VALUES(?,?,?,?)",
                (clean_team_id, member_id, now, str(added_by or "") or None),
            )
            conn.commit()
            return {
                "created": True,
                "account": {
                    "id": member_id, "name": display_name,
                    "username": username, "createdAt": now,
                },
                "temporaryPassword": temporary_password,
            }, None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def reset_team_supplier_pin(team_id, supplier_parent_id, pin):
    clean_pin = str(pin or "")
    if not clean_pin:
        return None
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT m.id,m.name,m.username,m.pin_hash,m.role,m.parent_id,m.avatar_url,m.created_at "
                "FROM team_suppliers ts JOIN members m ON m.id=ts.supplier_parent_id "
                "WHERE ts.team_id=? AND ts.supplier_parent_id=? AND m.role='supplier_parent'",
                (team_id, supplier_parent_id),
            ).fetchone()
            if not row:
                conn.rollback()
                return None
            conn.execute(
                "UPDATE members SET pin_hash=? WHERE id=?",
                (hash_pin(clean_pin), supplier_parent_id),
            )
            conn.commit()
            return _member_public(row)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


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
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT id,name,username,pin_hash,role,status,username_key "
                "FROM member_requests WHERE id=?",
                (rid,),
            ).fetchone()
            if not row:
                return None, "not_found"
            if row[5] != "pending":
                return None, "not_pending"
            username_key = row[6] or canonical_username(row[2])
            if conn.execute(
                "SELECT id FROM members WHERE username_key=? LIMIT 1",
                (username_key,),
            ).fetchone():
                return None, "username_exists"
            mid = uuid.uuid4().hex[:10]
            now = int(time.time() * 1000)
            conn.execute(
                "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (
                    mid, row[1], normalize_username(row[2]), username_key,
                    row[3], row[4], parent_id if row[4] == "supplier_child" else None, now,
                ),
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
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            if not context:
                return []
            parent_ids = (
                _supplier_parent_ids_for_context_locked(conn, context)
                if include_all else {context["parentId"]}
            )
            if not parent_ids:
                return []
            marks = ",".join("?" for _ in parent_ids)
            rows = conn.execute(
                "SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at "
                f"FROM members WHERE role='supplier_child' AND parent_id IN ({marks}) ORDER BY created_at",
                tuple(sorted(parent_ids)),
            ).fetchall()
            return [_member_public(row) for row in rows]
        finally:
            conn.close()


def list_supplier_members(parent_id=None):
    """供应商管理员共享同一组织视图：可见全部管理员与子账号。"""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            parent_ids = _supplier_parent_ids_for_context_locked(conn, context)
            if not parent_ids:
                return []
            marks = ",".join("?" for _ in parent_ids)
            rows = conn.execute(
                "SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at FROM members "
                f"WHERE id IN ({marks}) OR (role='supplier_child' AND parent_id IN ({marks})) "
                "ORDER BY CASE role WHEN 'supplier_parent' THEN 0 ELSE 1 END, created_at",
                tuple(sorted(parent_ids)) * 2,
            ).fetchall()
            return [_member_public(row) for row in rows]
        finally:
            conn.close()


def supplier_child_for(parent_id, child_id, include_all=False):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            row = _supplier_member_row_locked(conn, context, child_id, include_all)
            return row if row and row[4] == "supplier_child" else None
        finally:
            conn.close()


def supplier_member_for(parent_id, member_id):
    """Return a supplier member only when the actor and target share a team."""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            return _supplier_member_row_locked(conn, context, member_id, include_all=True)
        finally:
            conn.close()


def update_supplier_member(parent_id, member_id, *, name=None, username=None, pin=None, child_only=False):
    """Atomically scope-check and update one member in the supplier team."""
    clean_username = None
    username_key = None
    if username is not None:
        clean_username = normalize_username(username)
        username_key = canonical_username(clean_username)
        if not username_key:
            return None, "username_required"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            row = _supplier_member_row_locked(conn, context, member_id, include_all=True)
            if not row or (child_only and row[4] != "supplier_child"):
                conn.rollback()
                return None, "not_found"
            if clean_username is not None and (
                conn.execute(
                    "SELECT 1 FROM members WHERE username_key=? AND id<>? LIMIT 1",
                    (username_key, str(member_id)),
                ).fetchone()
                or conn.execute(
                    "SELECT 1 FROM member_requests "
                    "WHERE username_key=? AND status='pending' LIMIT 1",
                    (username_key,),
                ).fetchone()
            ):
                conn.rollback()
                return None, "username_exists"
            sets = []
            values = []
            if name is not None:
                sets.append("name=?")
                values.append(name)
            if clean_username is not None:
                sets.extend(("username=?", "username_key=?"))
                values.extend((clean_username, username_key))
            if pin:
                sets.append("pin_hash=?")
                values.append(hash_pin(pin))
            if sets:
                conn.execute(
                    f"UPDATE members SET {','.join(sets)} WHERE id=?",
                    (*values, str(member_id)),
                )
            updated = conn.execute(
                "SELECT id,name,username,pin_hash,role,parent_id,avatar_url,created_at "
                "FROM members WHERE id=?",
                (str(member_id),),
            ).fetchone()
            conn.commit()
            return updated, None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def create_supplier_children(parent_id, items):
    normalized = []
    for item in items or []:
        name = str((item or {}).get("name") or "").strip()
        username = normalize_username((item or {}).get("username"))
        pin = str((item or {}).get("pin") or "")
        if not name or not username or not pin:
            raise ValueError("missing_fields")
        normalized.append((name, username, canonical_username(username), pin))
    username_keys = [row[2] for row in normalized]
    if len(set(username_keys)) != len(username_keys):
        raise ValueError("username_exists")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            if not context:
                raise PermissionError("forbidden")
            for _name, _username, username_key, _pin in normalized:
                if conn.execute(
                    "SELECT 1 FROM members WHERE username_key=? LIMIT 1",
                    (username_key,),
                ).fetchone() or conn.execute(
                    "SELECT 1 FROM member_requests WHERE username_key=? AND status='pending' LIMIT 1",
                    (username_key,),
                ).fetchone():
                    raise ValueError("username_exists")
            made = []
            now = int(time.time() * 1000)
            for index, (name, username, username_key, pin) in enumerate(normalized):
                mid = uuid.uuid4().hex[:10]
                conn.execute(
                    "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (
                        mid, name, username, username_key, hash_pin(pin),
                        "supplier_child", context["parentId"], now + index,
                    ),
                )
                made.append({
                    "id": mid, "name": name, "username": username,
                    "role": "supplier_child", "parentId": context["parentId"], "createdAt": now + index,
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
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            if not context:
                return []
            parent_ids = (
                _supplier_parent_ids_for_context_locked(conn, context)
                if include_all else {context["parentId"]}
            )
            if not parent_ids:
                return []
            marks = ",".join("?" for _ in parent_ids)
            rows = conn.execute(
                "SELECT b.parent_id,b.child_id,b.account_id,b.created_at,b.created_by "
                "FROM supplier_account_bindings b "
                "JOIN members c ON c.id=b.child_id AND c.role='supplier_child' "
                "AND c.parent_id=b.parent_id "
                "JOIN team_accounts ta ON ta.account_id=b.account_id AND ta.team_id=? "
                f"WHERE b.parent_id IN ({marks}) ORDER BY b.created_at",
                (context["teamId"], *tuple(sorted(parent_ids))),
            ).fetchall()
            return [{"parentId": r[0], "childId": r[1], "accountId": r[2], "createdAt": r[3], "createdBy": r[4]} for r in rows]
        finally:
            conn.close()


def supplier_account_ids_for_child(child_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            context = _supplier_access_context_locked(conn, child_id, "supplier_child")
            if not context:
                return set()
            rows = conn.execute(
                "SELECT b.account_id FROM supplier_account_bindings b "
                "JOIN team_accounts ta ON ta.account_id=b.account_id AND ta.team_id=? "
                "WHERE b.parent_id=? AND b.child_id=?",
                (context["teamId"], context["parentId"], context["memberId"]),
            ).fetchall()
            return {str(row[0]) for row in rows}
        finally:
            conn.close()


def set_supplier_child_accounts(parent_id, child_id, account_ids, actor_id, include_all=False):
    ids = sorted({str(x) for x in (account_ids or []) if str(x)})
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            child = _supplier_member_row_locked(conn, context, child_id, include_all)
            if not child or child[4] != "supplier_child":
                conn.rollback()
                return False
            actual_parent_id = str(child[5] or "")
            if ids:
                marks = ",".join("?" for _ in ids)
                mapped = {
                    str(row[0]) for row in conn.execute(
                        f"SELECT account_id FROM team_accounts WHERE team_id=? AND account_id IN ({marks})",
                        (context["teamId"], *ids),
                    ).fetchall()
                }
                if mapped != set(ids):
                    conn.rollback()
                    return False
            conn.execute("DELETE FROM supplier_account_bindings WHERE child_id=?", (child_id,))
            now = int(time.time() * 1000)
            for aid in ids:
                # 一个内容账号在同一供应商母账号下只对应一个子账号，新的分配会安全迁移。
                conn.execute("DELETE FROM supplier_account_bindings WHERE parent_id=? AND account_id=?", (actual_parent_id, aid))
                conn.execute("INSERT INTO supplier_account_bindings(parent_id,child_id,account_id,created_at,created_by) VALUES(?,?,?,?,?)", (actual_parent_id, child_id, aid, now, actor_id))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    return True


def add_supplier_activity(parent_id, child_id, member_id, action, account_id="", asset_id="", detail=""):
    _ensure_db()
    now = int(time.time() * 1000)
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            context = _supplier_access_context_locked(conn, member_id)
            if not context or (parent_id and str(parent_id) != context["parentId"]):
                return False
            if account_id and not _supplier_account_allowed_locked(conn, context, account_id):
                return False
            if asset_id:
                asset_row = conn.execute(
                    "SELECT data FROM docs WHERE collection='assets' AND id=?",
                    (str(asset_id),),
                ).fetchone()
                try:
                    asset = json.loads(asset_row[0]) if asset_row else None
                except (TypeError, json.JSONDecodeError):
                    asset = None
                if not _supplier_asset_allowed_locked(conn, context, asset):
                    return False
            conn.execute(
                "INSERT INTO supplier_activity(id,parent_id,child_id,member_id,action,account_id,asset_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    uuid.uuid4().hex[:12], context["parentId"],
                    context["memberId"] if context["role"] == "supplier_child" else None,
                    context["memberId"], str(action or "")[:40], account_id or None,
                    asset_id or None, str(detail or "")[:300], now,
                ),
            )
            conn.commit()
            return True
        finally:
            conn.close()


def list_supplier_activity(parent_id, include_all=False, limit=80):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            context = _supplier_access_context_locked(conn, parent_id, "supplier_parent")
            if not context:
                return []
            parent_ids = (
                _supplier_parent_ids_for_context_locked(conn, context)
                if include_all else {context["parentId"]}
            )
            if not parent_ids:
                return []
            marks = ",".join("?" for _ in parent_ids)
            rows = conn.execute(
                "SELECT id,parent_id,child_id,member_id,action,account_id,asset_id,detail,created_at "
                f"FROM supplier_activity WHERE parent_id IN ({marks}) ORDER BY created_at DESC LIMIT ?",
                (*tuple(sorted(parent_ids)), limit),
            ).fetchall()
            safe_rows = []
            for row in rows:
                member = _supplier_member_row_locked(conn, context, row[3], include_all=True)
                if not member:
                    continue
                if row[5] and not _supplier_account_allowed_locked(conn, context, row[5]):
                    continue
                if row[6]:
                    asset_row = conn.execute(
                        "SELECT data FROM docs WHERE collection='assets' AND id=?", (str(row[6]),)
                    ).fetchone()
                    try:
                        asset = json.loads(asset_row[0]) if asset_row else None
                    except (TypeError, json.JSONDecodeError):
                        asset = None
                    if not _supplier_asset_allowed_locked(conn, context, asset):
                        continue
                safe_rows.append(row)
            members = {r[0]: r[1] for r in conn.execute("SELECT id,name FROM members").fetchall()}
            return [{"id": r[0], "parentId": r[1], "childId": r[2], "memberId": r[3], "memberName": members.get(r[3], "成员"), "action": r[4], "accountId": r[5], "assetId": r[6], "detail": r[7] or "", "createdAt": r[8]} for r in safe_rows]
        finally:
            conn.close()


# ---------- 模型用量 receipt / outbox（两阶段、幂等、可补偿） ----------
_MODEL_USAGE_KINDS = {"llm", "image", "video", "voice"}
_MODEL_USAGE_RECEIPT_COLUMNS = (
    "receipt_id,receipt_key,member_id,member_name,team_id,surface,feature,usage_kind,"
    "provider,model,operation,operation_id,idempotency_key,request_fingerprint,"
    "provider_ref,call_status,prompt_tokens,completion_tokens,total_tokens,calls,"
    "output_units,unit_label,source,error,event_at,created_at,updated_at,completed_at"
)


def _model_usage_text(value, limit, *, required=""):
    text = str(value or "").strip()
    if required and not text:
        raise ValueError(f"{required}_required")
    return text[:limit]


def _model_usage_busy_error(exc):
    code = getattr(exc, "sqlite_errorcode", None)
    if code in {getattr(sqlite3, "SQLITE_BUSY", 5), getattr(sqlite3, "SQLITE_LOCKED", 6)}:
        return True
    message = str(exc or "").lower()
    return "database is locked" in message or "database is busy" in message


def _model_usage_finish_write_batch(batch, outcomes):
    global _model_usage_write_active
    with _model_usage_write_condition:
        for request, (succeeded, value) in zip(batch, outcomes):
            if succeeded:
                request["result"] = value
            else:
                request["error"] = value
            request["done"] = True
            request["processing"] = False
        _model_usage_write_active = False
        _model_usage_write_condition.notify_all()


def _model_usage_fail_write_batch(batch, message):
    _model_usage_finish_write_batch(
        batch,
        [
            (False, ModelUsageReceiptWriteError(message))
            for _request in batch
        ],
    )


def _model_usage_run_write_batch():
    """Commit currently queued process-local receipt writes as one durable unit."""

    global _model_usage_write_queue, _model_usage_write_active
    time.sleep(MODEL_USAGE_WRITE_BATCH_WINDOW_SECONDS)
    with _model_usage_write_condition:
        now = time.monotonic()
        queued = _model_usage_write_queue
        _model_usage_write_queue = []
        batch = []
        for request in queued:
            if request["deadline"] <= now:
                request["error"] = ModelUsageReceiptWriteError(
                    "model usage receipt database remained busy"
                )
                request["done"] = True
            else:
                request["processing"] = True
                batch.append(request)
        if not batch:
            _model_usage_write_active = False
            _model_usage_write_condition.notify_all()
            return
        _model_usage_write_condition.notify_all()

    deadline = min(request["deadline"] for request in batch)
    last_error = None
    for attempt in range(MODEL_USAGE_WRITE_RETRY_ATTEMPTS):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        conn = None
        try:
            conn = _connect_model_usage_write(
                busy_timeout_ms=min(
                    MODEL_USAGE_WRITE_BUSY_TIMEOUT_MS,
                    max(1, int(remaining * 1000)),
                )
            )
            conn.execute("BEGIN IMMEDIATE")
            outcomes = []
            for index, request in enumerate(batch):
                savepoint = f"model_usage_batch_{index}"
                conn.execute(f"SAVEPOINT {savepoint}")
                try:
                    result = request["operation"](conn)
                    conn.execute(f"RELEASE SAVEPOINT {savepoint}")
                    outcomes.append((True, result))
                except sqlite3.DatabaseError:
                    try:
                        conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                        conn.execute(f"RELEASE SAVEPOINT {savepoint}")
                    except sqlite3.Error:
                        pass
                    raise
                except Exception as exc:
                    conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    conn.execute(f"RELEASE SAVEPOINT {savepoint}")
                    outcomes.append((False, exc))
            conn.commit()
            _model_usage_finish_write_batch(batch, outcomes)
            return
        except sqlite3.OperationalError as exc:
            last_error = exc
            if conn is not None:
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
            if not _model_usage_busy_error(exc):
                _model_usage_fail_write_batch(
                    batch, "model usage receipt write failed"
                )
                return
            if attempt + 1 >= MODEL_USAGE_WRITE_RETRY_ATTEMPTS:
                break
        except sqlite3.DatabaseError:
            if conn is not None:
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
            _model_usage_fail_write_batch(batch, "model usage receipt write failed")
            return
        except Exception as exc:
            if conn is not None:
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
            _model_usage_finish_write_batch(
                batch, [(False, exc) for _request in batch]
            )
            return
        finally:
            if conn is not None:
                conn.close()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(
            MODEL_USAGE_WRITE_RETRY_BASE_SECONDS * (2 ** attempt),
            remaining,
        ))
    _model_usage_fail_write_batch(
        batch, "model usage receipt database remained busy"
    )


def _model_usage_write(operation):
    """Run one bounded, durable receipt write without using ``store._lock``.

    Concurrent same-process requests are micro-batched so SQLite performs one
    FULL-durability commit instead of a synchronized retry storm.  Savepoints
    preserve each operation's own conflict/error result, while ``BEGIN
    IMMEDIATE`` and the receipt unique indexes remain the cross-process
    exactly-once authority.  A caller returns only after the batch commits; a
    pre-call receipt failure therefore still prevents the provider call.
    """

    global _model_usage_write_active
    request = {
        "operation": operation,
        "deadline": time.monotonic() + MODEL_USAGE_WRITE_MAX_SECONDS,
        "processing": False,
        "done": False,
        "result": None,
        "error": None,
    }
    with _model_usage_write_condition:
        _model_usage_write_queue.append(request)
        _model_usage_write_condition.notify_all()

    while True:
        leader = False
        with _model_usage_write_condition:
            if request["done"]:
                if request["error"] is not None:
                    raise request["error"]
                return request["result"]
            remaining = request["deadline"] - time.monotonic()
            if remaining <= 0 and not request["processing"]:
                try:
                    _model_usage_write_queue.remove(request)
                except ValueError:
                    pass
                raise ModelUsageReceiptWriteError(
                    "model usage receipt database remained busy"
                )
            if (
                not _model_usage_write_active
                and _model_usage_write_queue
                and _model_usage_write_queue[0] is request
            ):
                _model_usage_write_active = True
                leader = True
            else:
                _model_usage_write_condition.wait(
                    timeout=None if request["processing"] else max(0.001, remaining)
                )
        if leader:
            _model_usage_run_write_batch()


def _model_usage_receipt_dict(row, *, created=False, reused=False, outbox_state=""):
    if not row:
        return None
    return {
        "receiptId": row[0],
        "receiptKey": row[1],
        "memberId": row[2],
        "memberName": row[3],
        "teamId": row[4],
        "surface": row[5],
        "feature": row[6],
        "usageKind": row[7],
        "provider": row[8],
        "model": row[9],
        "operation": row[10],
        "operationId": row[11],
        "idempotencyKey": row[12],
        "requestFingerprint": row[13],
        "providerRef": row[14],
        "status": row[15],
        "promptTokens": int(row[16] or 0),
        "completionTokens": int(row[17] or 0),
        "totalTokens": int(row[18] or 0),
        "calls": int(row[19] or 0),
        "outputUnits": int(row[20] or 0),
        "unitLabel": row[21] or "",
        "source": row[22],
        "error": row[23] or "",
        "eventAt": row[24],
        "createdAt": row[25],
        "updatedAt": row[26],
        "completedAt": row[27],
        "created": bool(created),
        "reused": bool(reused),
        "shouldCallProvider": bool(created and row[15] == "pending"),
        "outboxState": outbox_state or "",
    }


def _model_usage_receipt_identifiers(source, member_id, stable_credential):
    receipt_key = hashlib.sha256(
        f"model-usage-v1|{source}|{member_id}|{stable_credential}".encode("utf-8")
    ).hexdigest()
    return receipt_key, "mur_" + receipt_key[:28]


def _model_usage_receipt_row_locked(conn, receipt_id):
    return conn.execute(
        f"SELECT {_MODEL_USAGE_RECEIPT_COLUMNS} FROM model_usage_receipts "
        "WHERE receipt_id=?",
        (str(receipt_id or ""),),
    ).fetchone()


def _model_usage_outbox_state_locked(conn, receipt_id):
    row = conn.execute(
        "SELECT state FROM model_usage_outbox WHERE receipt_id=?",
        (str(receipt_id or ""),),
    ).fetchone()
    return str(row[0] or "") if row else ""


def _model_usage_authority_locked(conn, member_id, requested_team_id=""):
    member = conn.execute(
        "SELECT id,name FROM members WHERE id=?",
        (str(member_id or ""),),
    ).fetchone()
    if not member:
        raise ValueError("model_usage_member_not_found")
    teams = conn.execute(
        "SELECT team_id FROM team_members WHERE member_id=? AND status='active' "
        "ORDER BY team_id",
        (member[0],),
    ).fetchall()
    active_team_ids = [str(row[0] or "") for row in teams if str(row[0] or "")]
    requested_team_id = str(requested_team_id or "").strip()
    if requested_team_id:
        if requested_team_id not in active_team_ids:
            raise ModelUsageReceiptConflict("model_usage_team_mismatch")
        actual_team_id = requested_team_id
    elif len(active_team_ids) > 1:
        raise ModelUsageReceiptConflict("model_usage_team_ambiguous")
    else:
        actual_team_id = active_team_ids[0] if active_team_ids else ""
    return str(member[0]), str(member[1] or "成员")[:120], actual_team_id


def begin_model_usage_receipt(
    member_id,
    *,
    surface,
    feature,
    usage_kind,
    operation,
    operation_id,
    request_fingerprint,
    source="main",
    idempotency_key="",
    provider="",
    model="",
    team_id="",
    member_name="",
    now_ms=None,
):
    """Persist a pre-provider intent and return whether the provider may run.

    Reusing the same source/idempotency credential never authorizes a second
    provider call.  A failed attempt therefore needs a new explicit attempt key.
    ``member_name`` is accepted for caller compatibility but the stored name and
    team are resolved authoritatively from the member tables.
    """

    del member_name
    member_id = _model_usage_text(member_id, 120, required="member_id")
    surface = _model_usage_text(surface, 80, required="surface")
    feature = _model_usage_text(feature, 120, required="feature")
    usage_kind = _model_usage_text(usage_kind, 24, required="usage_kind").lower()
    if usage_kind not in _MODEL_USAGE_KINDS:
        raise ValueError("model_usage_kind_invalid")
    operation = _model_usage_text(operation, 80, required="operation")
    operation_id = _model_usage_text(operation_id, 180, required="operation_id")
    request_fingerprint = _model_usage_text(
        request_fingerprint, 128, required="request_fingerprint"
    )
    source = _model_usage_text(source, 80, required="source")
    idempotency_key = _model_usage_text(idempotency_key, 220)
    provider = _model_usage_text(provider, 80, required="provider")
    model = _model_usage_text(model, 180, required="model")
    stable_credential = idempotency_key or operation_id
    receipt_key, receipt_id = _model_usage_receipt_identifiers(
        source, member_id, stable_credential
    )
    now = _usage_int(now_ms) or int(time.time() * 1000)
    _ensure_db()

    def write(conn):
        resolved_member_id, resolved_name, resolved_team_id = _model_usage_authority_locked(
            conn, member_id, team_id
        )
        existing = conn.execute(
            f"SELECT {_MODEL_USAGE_RECEIPT_COLUMNS} FROM model_usage_receipts "
            "WHERE receipt_key=?",
            (receipt_key,),
        ).fetchone()
        if existing:
            expected_identity = (
                resolved_member_id,
                resolved_team_id,
                surface,
                feature,
                usage_kind,
                operation,
                operation_id,
                idempotency_key,
                request_fingerprint,
                source,
                provider,
                model,
            )
            stored_identity = (
                existing[2], existing[4], existing[5], existing[6], existing[7],
                existing[10], existing[11], existing[12], existing[13], existing[22],
                existing[8], existing[9],
            )
            if stored_identity != expected_identity:
                raise ModelUsageReceiptConflict(
                    "model usage idempotency credential payload mismatch"
                )
            return _model_usage_receipt_dict(
                existing,
                reused=True,
                outbox_state=_model_usage_outbox_state_locked(conn, existing[0]),
            )
        conn.execute(
            "INSERT INTO model_usage_receipts("
            "receipt_id,receipt_key,member_id,member_name,team_id,surface,feature,usage_kind,"
            "provider,model,operation,operation_id,idempotency_key,request_fingerprint,"
            "provider_ref,call_status,prompt_tokens,completion_tokens,total_tokens,calls,"
            "output_units,unit_label,source,error,event_at,created_at,updated_at,completed_at"
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                receipt_id, receipt_key, resolved_member_id, resolved_name, resolved_team_id,
                surface, feature, usage_kind, provider, model, operation, operation_id,
                idempotency_key, request_fingerprint, "", "pending", 0, 0, 0, 0, 0,
                "", source, "", None, now, now, None,
            ),
        )
        conn.execute(
            "INSERT INTO model_usage_outbox("
            "receipt_id,state,attempts,available_at,last_error,legacy_event_kind,"
            "legacy_event_id,created_at,updated_at,projected_at"
            ") VALUES(?,'waiting',0,?,'','','',?,?,NULL)",
            (receipt_id, now, now, now),
        )
        row = _model_usage_receipt_row_locked(conn, receipt_id)
        return _model_usage_receipt_dict(row, created=True, outbox_state="waiting")

    return _model_usage_write(write)


def find_model_usage_receipt(member_id, *, source, stable_credential):
    """Read an existing immutable receipt without acquiring a SQLite write lock.

    Project polling may replay hundreds of already-terminal sidecar receipts.
    Their deterministic source/member/credential identity permits a read-only
    lookup; the caller must still compare the complete immutable payload before
    trusting the result.  Initial concurrent misses continue through
    ``begin_model_usage_receipt`` where the unique indexes serialize creation.
    """

    member_id = _model_usage_text(member_id, 120, required="member_id")
    source = _model_usage_text(source, 80, required="source")
    stable_credential = _model_usage_text(
        stable_credential, 220, required="stable_credential"
    )
    receipt_key, _ = _model_usage_receipt_identifiers(
        source, member_id, stable_credential
    )
    _ensure_db()
    conn = _connect(read_only=True)
    try:
        row = conn.execute(
            f"SELECT {_MODEL_USAGE_RECEIPT_COLUMNS} FROM model_usage_receipts "
            "WHERE receipt_key=?",
            (receipt_key,),
        ).fetchone()
        return _model_usage_receipt_dict(
            row,
            reused=bool(row),
            outbox_state=(
                _model_usage_outbox_state_locked(conn, row[0]) if row else ""
            ),
        )
    finally:
        conn.close()


def complete_model_usage_receipt(
    receipt_id,
    *,
    usage=None,
    provider_ref="",
    provider="",
    model="",
    calls=1,
    output_units=0,
    unit_label="",
    error="",
    event_at=None,
    now_ms=None,
):
    """Confirm one successful provider call and enqueue legacy projection."""

    receipt_id = _model_usage_text(receipt_id, 80, required="receipt_id")
    usage_data = usage if isinstance(usage, dict) else {}
    prompt = _usage_int(usage_data.get("prompt_tokens", usage_data.get("input_tokens")))
    completion = _usage_int(
        usage_data.get("completion_tokens", usage_data.get("output_tokens"))
    )
    total = _usage_int(usage_data.get("total_tokens")) or prompt + completion
    call_count = _usage_int(calls)
    if call_count != 1:
        raise ValueError("model_usage_receipt_must_represent_one_call")
    units = _usage_int(output_units)
    provider_ref = _model_usage_text(provider_ref, 240)
    provider = _model_usage_text(provider, 80)
    model = _model_usage_text(model, 180)
    unit_label = _model_usage_text(unit_label, 24)
    completion_error = _model_usage_text(error, 500)
    now = _usage_int(now_ms) or int(time.time() * 1000)
    occurred_at = _usage_int(event_at) or now
    _ensure_db()

    def write(conn):
        row = _model_usage_receipt_row_locked(conn, receipt_id)
        if not row:
            raise ValueError("model_usage_receipt_not_found")
        if row[15] == "failed":
            raise ModelUsageReceiptConflict(
                "failed model usage attempt requires a new attempt key"
            )
        actual_provider = provider or str(row[8] or "")
        actual_model = model or str(row[9] or "")
        if provider_ref:
            duplicate = conn.execute(
                "SELECT receipt_id FROM model_usage_receipts "
                "WHERE provider=? AND provider_ref=? AND usage_kind=? AND receipt_id<>?",
                (actual_provider, provider_ref, row[7], receipt_id),
            ).fetchone()
            if duplicate:
                raise ModelUsageReceiptConflict("model_usage_provider_ref_reused")
        if row[15] == "succeeded":
            replay_values = (
                actual_provider,
                actual_model,
                provider_ref or str(row[14] or ""),
                prompt,
                completion,
                total,
                call_count,
                units,
                unit_label,
                completion_error or str(row[23] or ""),
            )
            stored_values = (
                str(row[8] or ""), str(row[9] or ""), str(row[14] or ""),
                int(row[16] or 0), int(row[17] or 0), int(row[18] or 0),
                int(row[19] or 0), int(row[20] or 0), str(row[21] or ""),
                str(row[23] or ""),
            )
            if replay_values != stored_values:
                raise ModelUsageReceiptConflict(
                    "completed model usage receipt payload mismatch"
                )
            return _model_usage_receipt_dict(
                row,
                reused=True,
                outbox_state=_model_usage_outbox_state_locked(conn, receipt_id),
            )
        conn.execute(
            "UPDATE model_usage_receipts SET provider=?,model=?,provider_ref=?,"
            "call_status='succeeded',prompt_tokens=?,completion_tokens=?,total_tokens=?,"
            "calls=?,output_units=?,unit_label=?,error=?,event_at=?,updated_at=?,"
            "completed_at=? WHERE receipt_id=?",
            (
                actual_provider, actual_model, provider_ref, prompt, completion, total,
                call_count, units, unit_label, completion_error, occurred_at, now, now,
                receipt_id,
            ),
        )
        conn.execute(
            "UPDATE model_usage_outbox SET state='pending',available_at=?,last_error='',"
            "updated_at=?,projected_at=NULL WHERE receipt_id=?",
            (now, now, receipt_id),
        )
        updated = _model_usage_receipt_row_locked(conn, receipt_id)
        return _model_usage_receipt_dict(updated, outbox_state="pending")

    return _model_usage_write(write)


def fail_model_usage_receipt(
    receipt_id,
    error,
    *,
    status="failed",
    now_ms=None,
):
    """Mark a pre-call intent as definitively failed or provider-unknown."""

    receipt_id = _model_usage_text(receipt_id, 80, required="receipt_id")
    status = _model_usage_text(status, 24, required="status").lower()
    if status not in {"failed", "unknown"}:
        raise ValueError("model_usage_failure_status_invalid")
    safe_error = _model_usage_text(error, 500) or "unspecified_error"
    now = _usage_int(now_ms) or int(time.time() * 1000)
    _ensure_db()

    def write(conn):
        row = _model_usage_receipt_row_locked(conn, receipt_id)
        if not row:
            raise ValueError("model_usage_receipt_not_found")
        if row[15] == "succeeded":
            raise ModelUsageReceiptConflict("completed model usage receipt cannot be downgraded")
        if row[15] == status:
            return _model_usage_receipt_dict(
                row,
                reused=True,
                outbox_state=_model_usage_outbox_state_locked(conn, receipt_id),
            )
        outbox_state = "ignored" if status == "failed" else "unresolved"
        conn.execute(
            "UPDATE model_usage_receipts SET call_status=?,error=?,updated_at=?,"
            "completed_at=? WHERE receipt_id=?",
            (status, safe_error, now, now if status == "failed" else None, receipt_id),
        )
        conn.execute(
            "UPDATE model_usage_outbox SET state=?,available_at=?,last_error=?,updated_at=? "
            "WHERE receipt_id=?",
            (outbox_state, now, safe_error, now, receipt_id),
        )
        updated = _model_usage_receipt_row_locked(conn, receipt_id)
        return _model_usage_receipt_dict(updated, outbox_state=outbox_state)

    return _model_usage_write(write)


def mark_model_usage_receipt_unknown(receipt_id, error, *, now_ms=None):
    return fail_model_usage_receipt(
        receipt_id, error, status="unknown", now_ms=now_ms
    )


def get_model_usage_receipt(receipt_id):
    receipt_id = str(receipt_id or "").strip()
    if not receipt_id:
        return None
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = _model_usage_receipt_row_locked(conn, receipt_id)
            return _model_usage_receipt_dict(
                row,
                outbox_state=_model_usage_outbox_state_locked(conn, receipt_id) if row else "",
            )
        finally:
            conn.close()


def unresolved_model_usage_receipts(limit=100):
    try:
        limit = max(1, min(int(limit or 100), 1000))
    except (TypeError, ValueError, OverflowError):
        limit = 100
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            aliased_columns = "r." + _MODEL_USAGE_RECEIPT_COLUMNS.replace(",", ",r.")
            rows = conn.execute(
                f"SELECT {aliased_columns} FROM model_usage_receipts r "
                "LEFT JOIN model_usage_outbox o ON o.receipt_id=r.receipt_id "
                "WHERE r.call_status IN ('pending','unknown') "
                "OR (r.call_status='succeeded' AND COALESCE(o.state,'')<>'projected') "
                "ORDER BY r.updated_at ASC LIMIT ?",
                (limit,),
            ).fetchall()
            return [_model_usage_receipt_dict(row) for row in rows]
        finally:
            conn.close()


def _model_usage_legacy_event_id(receipt_id, usage_kind):
    digest = hashlib.sha256(
        f"legacy-model-usage-v1|{usage_kind}|{receipt_id}".encode("utf-8")
    ).hexdigest()
    return "mup_" + digest[:28]


def reconcile_model_usage_outbox(limit=100, *, receipt_id="", now_ms=None):
    """Idempotently project completed receipts into the unchanged legacy ledgers."""

    try:
        limit = max(1, min(int(limit or 100), 1000))
    except (TypeError, ValueError, OverflowError):
        limit = 100
    receipt_id = str(receipt_id or "").strip()
    now = _usage_int(now_ms) or int(time.time() * 1000)
    _ensure_db()

    def write(conn):
        where_receipt = "AND r.receipt_id=? " if receipt_id else ""
        params = (now, receipt_id, limit) if receipt_id else (now, limit)
        aliased_columns = "r." + _MODEL_USAGE_RECEIPT_COLUMNS.replace(",", ",r.")
        rows = conn.execute(
            f"SELECT {aliased_columns} FROM model_usage_receipts r "
            "JOIN model_usage_outbox o ON o.receipt_id=r.receipt_id "
            "WHERE r.call_status='succeeded' AND o.state IN ('pending','retry') "
            "AND o.available_at<=? " + where_receipt +
            "ORDER BY o.created_at ASC LIMIT ?",
            params,
        ).fetchall()
        projected = 0
        failed = 0
        receipt_only = 0
        for row in rows:
            current_receipt_id = str(row[0])
            usage_kind = str(row[7])
            legacy_kind = ""
            legacy_id = ""
            is_receipt_only = False
            conn.execute("SAVEPOINT model_usage_projection")
            try:
                if usage_kind == "llm" and int(row[18] or 0) > 0:
                    legacy_kind = "llm_usage_events"
                    legacy_id = _model_usage_legacy_event_id(current_receipt_id, usage_kind)
                    legacy_created_at = row[24] or row[26]
                    conn.execute(
                        "INSERT OR IGNORE INTO llm_usage_events("
                        "id,member_id,member_name,feature,model,prompt_tokens,"
                        "completion_tokens,total_tokens,created_at"
                        ") VALUES(?,?,?,?,?,?,?,?,?)",
                        (
                            legacy_id, row[2], row[3], row[6], row[9], row[16],
                            row[17], row[18], legacy_created_at,
                        ),
                    )
                    stored = conn.execute(
                        "SELECT member_id,member_name,feature,COALESCE(model,''),"
                        "prompt_tokens,completion_tokens,total_tokens,created_at "
                        "FROM llm_usage_events WHERE id=?",
                        (legacy_id,),
                    ).fetchone()
                    expected = (
                        row[2], row[3], row[6], str(row[9] or ""), int(row[16] or 0),
                        int(row[17] or 0), int(row[18] or 0), legacy_created_at,
                    )
                    if tuple(stored or ()) != expected:
                        raise ModelUsageReceiptConflict(
                            "model usage legacy LLM event collision"
                        )
                elif usage_kind in {"image", "video", "voice"}:
                    legacy_kind = "api_usage_events"
                    legacy_id = _model_usage_legacy_event_id(current_receipt_id, usage_kind)
                    legacy_created_at = row[24] or row[26]
                    legacy_unit_label = row[21] or "任务"
                    conn.execute(
                        "INSERT OR IGNORE INTO api_usage_events("
                        "id,member_id,member_name,api_type,feature,model,calls,"
                        "output_units,unit_label,created_at"
                        ") VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            legacy_id, row[2], row[3], usage_kind, row[6], row[9],
                            row[19], row[20], legacy_unit_label, legacy_created_at,
                        ),
                    )
                    stored = conn.execute(
                        "SELECT member_id,member_name,api_type,feature,COALESCE(model,''),"
                        "calls,output_units,unit_label,created_at FROM api_usage_events WHERE id=?",
                        (legacy_id,),
                    ).fetchone()
                    expected = (
                        row[2], row[3], usage_kind, row[6], str(row[9] or ""),
                        int(row[19] or 0), int(row[20] or 0), legacy_unit_label,
                        legacy_created_at,
                    )
                    if tuple(stored or ()) != expected:
                        raise ModelUsageReceiptConflict(
                            "model usage legacy API event collision"
                        )
                else:
                    legacy_kind = "receipt_only"
                    is_receipt_only = True
                conn.execute(
                    "UPDATE model_usage_outbox SET state='projected',legacy_event_kind=?,"
                    "legacy_event_id=?,last_error='',updated_at=?,projected_at=? "
                    "WHERE receipt_id=?",
                    (legacy_kind, legacy_id, now, now, current_receipt_id),
                )
                conn.execute("RELEASE SAVEPOINT model_usage_projection")
                projected += 1
                if is_receipt_only:
                    receipt_only += 1
            except Exception as exc:
                conn.execute("ROLLBACK TO SAVEPOINT model_usage_projection")
                conn.execute("RELEASE SAVEPOINT model_usage_projection")
                state = "conflict" if isinstance(exc, ModelUsageReceiptConflict) else "retry"
                delay = 0 if state == "conflict" else 1000
                conn.execute(
                    "UPDATE model_usage_outbox SET state=?,attempts=attempts+1,"
                    "available_at=?,last_error=?,updated_at=? WHERE receipt_id=?",
                    (
                        state, now + delay, type(exc).__name__[:120], now,
                        current_receipt_id,
                    ),
                )
                failed += 1
        return {
            "selected": len(rows),
            "projected": projected,
            "failed": failed,
            "receiptOnly": receipt_only,
        }

    return _model_usage_write(write)


def pending_model_usage_outbox_count():
    """Read how many completed receipts still need legacy projection."""

    _ensure_db()
    conn = _connect(read_only=True)
    try:
        return int(conn.execute(
            "SELECT COUNT(*) FROM model_usage_outbox "
            "WHERE state IN ('pending','retry')"
        ).fetchone()[0] or 0)
    finally:
        conn.close()


# ---------- 模型用量 completion spool（SQLite 锁外持久兜底） ----------
_MODEL_USAGE_COMPLETION_PAYLOAD_KEYS = frozenset({
    "version", "receiptId", "providerRef", "provider", "model",
    "promptTokens", "completionTokens", "totalTokens", "calls",
    "outputUnits", "unitLabel", "eventAt", "completedAt",
})
_MODEL_USAGE_COMPLETION_ENVELOPE_KEYS = frozenset({"checksum", "payload"})
_MODEL_USAGE_COMPLETION_MAX_BYTES = 32 * 1024


def _model_usage_completion_spool_root(spool_dir=None):
    if spool_dir is not None and str(spool_dir).strip():
        return Path(spool_dir).expanduser()
    configured = str(os.getenv("MODEL_USAGE_COMPLETION_SPOOL_DIR", "")).strip()
    if configured:
        return Path(configured).expanduser()
    # DB_PATH is intentionally resolved at call time so isolated tests and
    # explicit migration copies never write beside the import-time database.
    return DB_PATH.parent / "model_usage_spool"


def _model_usage_completion_spool_paths(spool_dir=None, *, create=False):
    root = _model_usage_completion_spool_root(spool_dir)
    paths = {
        "root": root,
        "pending": root / "pending",
        "archive": root / "archive",
        "locks": root / "locks",
    }
    if create:
        for path in paths.values():
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return paths


def _model_usage_completion_stem(receipt_id):
    return hashlib.sha256(
        f"model-usage-completion-spool-v1|{receipt_id}".encode("utf-8")
    ).hexdigest()


def _model_usage_completion_payload(
    receipt_id,
    *,
    usage=None,
    provider_ref="",
    provider="",
    model="",
    calls=1,
    output_units=0,
    unit_label="",
    event_at=None,
    now_ms=None,
):
    receipt_id = _model_usage_text(receipt_id, 80, required="receipt_id")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", receipt_id):
        raise ValueError("model_usage_spool_receipt_id_invalid")
    usage_data = usage if isinstance(usage, dict) else {}
    prompt = _usage_int(usage_data.get("prompt_tokens", usage_data.get("input_tokens")))
    completion = _usage_int(
        usage_data.get("completion_tokens", usage_data.get("output_tokens"))
    )
    total = _usage_int(usage_data.get("total_tokens")) or prompt + completion
    call_count = _usage_int(calls)
    if call_count != 1:
        raise ValueError("model_usage_receipt_must_represent_one_call")
    text_fields = {
        "providerRef": _model_usage_text(provider_ref, 240),
        "provider": _model_usage_text(provider, 80),
        "model": _model_usage_text(model, 180),
        "unitLabel": _model_usage_text(unit_label, 24),
    }
    if any("\n" in value or "\r" in value or "\x00" in value for value in text_fields.values()):
        raise ValueError("model_usage_spool_reference_invalid")
    return {
        "version": MODEL_USAGE_COMPLETION_SPOOL_VERSION,
        "receiptId": receipt_id,
        **text_fields,
        "promptTokens": prompt,
        "completionTokens": completion,
        "totalTokens": total,
        "calls": call_count,
        "outputUnits": _usage_int(output_units),
        "eventAt": _usage_int(event_at),
        "completedAt": _usage_int(now_ms),
    }


def _model_usage_completion_checksum(payload):
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _model_usage_completion_envelope(payload):
    return {
        "checksum": _model_usage_completion_checksum(payload),
        "payload": payload,
    }


def _model_usage_completion_encoded(envelope):
    return (
        json.dumps(
            envelope, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ) + "\n"
    ).encode("utf-8")


def _model_usage_fsync_directory(path):
    try:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        fd = os.open(path, flags)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _model_usage_atomic_create(path, content):
    """Durably create ``path`` without ever replacing an existing envelope."""

    temp_path = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        offset = 0
        while offset < len(content):
            offset += os.write(fd, content[offset:])
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.link(temp_path, path)
        _model_usage_fsync_directory(path.parent)
    finally:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass


def _read_model_usage_completion_envelope(path):
    try:
        if path.stat().st_size > _MODEL_USAGE_COMPLETION_MAX_BYTES:
            raise ModelUsageCompletionSpoolCorrupt("model usage spool envelope too large")
        raw = path.read_bytes()
    except FileNotFoundError:
        # A concurrent successful reconciliation may atomically rename a file
        # between directory enumeration and read.  Absence is not corruption.
        raise
    except ModelUsageCompletionSpoolCorrupt:
        raise
    except OSError as exc:
        raise ModelUsageCompletionSpoolCorrupt(
            "model usage spool envelope unreadable"
        ) from exc
    try:
        envelope = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ModelUsageCompletionSpoolCorrupt(
            "model usage spool envelope unreadable"
        ) from exc
    if not isinstance(envelope, dict) or set(envelope) != _MODEL_USAGE_COMPLETION_ENVELOPE_KEYS:
        raise ModelUsageCompletionSpoolCorrupt("model usage spool envelope schema invalid")
    checksum = envelope.get("checksum")
    payload = envelope.get("payload")
    if (
        not isinstance(checksum, str)
        or not re.fullmatch(r"[0-9a-f]{64}", checksum)
        or not isinstance(payload, dict)
        or set(payload) != _MODEL_USAGE_COMPLETION_PAYLOAD_KEYS
    ):
        raise ModelUsageCompletionSpoolCorrupt("model usage spool payload schema invalid")
    try:
        normalized = _model_usage_completion_payload(
            payload.get("receiptId"),
            usage={
                "prompt_tokens": payload.get("promptTokens"),
                "completion_tokens": payload.get("completionTokens"),
                "total_tokens": payload.get("totalTokens"),
            },
            provider_ref=payload.get("providerRef"),
            provider=payload.get("provider"),
            model=payload.get("model"),
            calls=payload.get("calls"),
            output_units=payload.get("outputUnits"),
            unit_label=payload.get("unitLabel"),
            event_at=payload.get("eventAt"),
            now_ms=payload.get("completedAt"),
        )
    except (TypeError, ValueError) as exc:
        raise ModelUsageCompletionSpoolCorrupt(
            "model usage spool payload values invalid"
        ) from exc
    if normalized != payload:
        raise ModelUsageCompletionSpoolCorrupt("model usage spool payload is not canonical")
    expected = _model_usage_completion_checksum(payload)
    if not hmac.compare_digest(checksum, expected):
        raise ModelUsageCompletionSpoolCorrupt("model usage spool checksum mismatch")
    expected_name = _model_usage_completion_stem(payload["receiptId"]) + ".json"
    if path.name != expected_name:
        raise ModelUsageCompletionSpoolCorrupt("model usage spool filename mismatch")
    return envelope


@contextmanager
def _model_usage_completion_file_lock(paths, receipt_id):
    stem = _model_usage_completion_stem(receipt_id)
    lock_path = paths["locks"] / f"{stem}.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield stem
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)


def spool_model_usage_completion(
    receipt_id,
    *,
    usage=None,
    provider_ref="",
    provider="",
    model="",
    calls=1,
    output_units=0,
    unit_label="",
    event_at=None,
    now_ms=None,
    spool_dir=None,
):
    """Persist one successful provider completion without touching SQLite.

    The strict envelope intentionally contains no prompt text, request body,
    API key, idempotency key, request fingerprint, member data or free-form
    provider error.  A receipt may have exactly one canonical completion; a
    different replay is preserved and rejected instead of overwriting evidence.
    """

    payload = _model_usage_completion_payload(
        receipt_id,
        usage=usage,
        provider_ref=provider_ref,
        provider=provider,
        model=model,
        calls=calls,
        output_units=output_units,
        unit_label=unit_label,
        event_at=event_at,
        now_ms=now_ms,
    )
    envelope = _model_usage_completion_envelope(payload)
    encoded = _model_usage_completion_encoded(envelope)
    if len(encoded) > _MODEL_USAGE_COMPLETION_MAX_BYTES:
        raise ValueError("model_usage_spool_envelope_too_large")
    paths = _model_usage_completion_spool_paths(spool_dir, create=True)
    with _model_usage_completion_file_lock(paths, payload["receiptId"]) as stem:
        pending_path = paths["pending"] / f"{stem}.json"
        archive_path = paths["archive"] / f"{stem}.json"
        for state, existing_path in (("archived", archive_path), ("pending", pending_path)):
            if not existing_path.exists():
                continue
            existing = _read_model_usage_completion_envelope(existing_path)
            if not hmac.compare_digest(existing["checksum"], envelope["checksum"]):
                raise ModelUsageCompletionSpoolConflict(
                    "model usage completion payload conflicts with persisted evidence"
                )
            return {
                "receiptId": payload["receiptId"],
                "checksum": envelope["checksum"],
                "state": state,
                "created": False,
                "reused": True,
            }
        try:
            _model_usage_atomic_create(pending_path, encoded)
        except FileExistsError:
            existing = _read_model_usage_completion_envelope(pending_path)
            if not hmac.compare_digest(existing["checksum"], envelope["checksum"]):
                raise ModelUsageCompletionSpoolConflict(
                    "model usage completion payload conflicts with persisted evidence"
                )
            return {
                "receiptId": payload["receiptId"],
                "checksum": envelope["checksum"],
                "state": "pending",
                "created": False,
                "reused": True,
            }
        return {
            "receiptId": payload["receiptId"],
            "checksum": envelope["checksum"],
            "state": "pending",
            "created": True,
            "reused": False,
        }


def model_usage_completion_spool_status(*, spool_dir=None):
    """Return a read-only integrity/count snapshot; never creates directories."""

    paths = _model_usage_completion_spool_paths(spool_dir, create=False)
    result = {
        "pending": 0,
        "archived": 0,
        "corrupt": 0,
        "conflicts": 0,
        "error": "",
    }
    if not paths["root"].exists():
        return result
    try:
        pending_files = sorted(paths["pending"].glob("*.json")) if paths["pending"].is_dir() else []
        archive_files = sorted(paths["archive"].glob("*.json")) if paths["archive"].is_dir() else []
    except OSError as exc:
        result["corrupt"] = 1
        result["error"] = type(exc).__name__
        return result
    result["pending"] = len(pending_files)
    result["archived"] = len(archive_files)
    archive_by_name = {path.name: path for path in archive_files}
    archive_checksums = {}
    for path in archive_files:
        try:
            archive_checksums[path.name] = _read_model_usage_completion_envelope(path)["checksum"]
        except FileNotFoundError:
            result["archived"] -= 1
        except ModelUsageCompletionSpoolCorrupt:
            result["corrupt"] += 1
    for path in pending_files:
        try:
            envelope = _read_model_usage_completion_envelope(path)
        except FileNotFoundError:
            result["pending"] -= 1
            continue
        except ModelUsageCompletionSpoolCorrupt:
            result["corrupt"] += 1
            continue
        if path.name in archive_by_name:
            archived_checksum = archive_checksums.get(path.name)
            if archived_checksum and not hmac.compare_digest(
                archived_checksum, envelope["checksum"]
            ):
                result["conflicts"] += 1
    return result


def _archive_model_usage_completion(paths, pending_path, envelope):
    archive_path = paths["archive"] / pending_path.name
    if archive_path.exists():
        archived = _read_model_usage_completion_envelope(archive_path)
        if not hmac.compare_digest(archived["checksum"], envelope["checksum"]):
            raise ModelUsageCompletionSpoolConflict(
                "model usage completion archive conflicts with pending evidence"
            )
        pending_path.unlink()
        _model_usage_fsync_directory(paths["pending"])
        return True
    os.rename(pending_path, archive_path)
    _model_usage_fsync_directory(paths["pending"])
    _model_usage_fsync_directory(paths["archive"])
    return False


def reconcile_model_usage_completion_spool(limit=100, *, spool_dir=None):
    """Replay verified completions, project the outbox, then atomically archive.

    Corrupt or conflicting evidence is never changed.  SQLite failures leave the
    pending file intact so an explicit later reconciliation can safely retry.
    This function is not invoked on import or normal service startup.
    """

    try:
        limit = max(1, min(int(limit or 100), 1000))
    except (TypeError, ValueError, OverflowError):
        limit = 100
    paths = _model_usage_completion_spool_paths(spool_dir, create=True)
    pending_files = sorted(paths["pending"].glob("*.json"))[:limit]
    result = {
        "selected": len(pending_files),
        "completed": 0,
        "projected": 0,
        "archived": 0,
        "archiveReused": 0,
        "corrupt": 0,
        "conflicts": 0,
        "failed": 0,
    }
    for candidate in pending_files:
        try:
            initial = _read_model_usage_completion_envelope(candidate)
            receipt_id = initial["payload"]["receiptId"]
        except FileNotFoundError:
            continue
        except ModelUsageCompletionSpoolCorrupt:
            result["corrupt"] += 1
            continue
        with _model_usage_completion_file_lock(paths, receipt_id) as stem:
            pending_path = paths["pending"] / f"{stem}.json"
            if not pending_path.exists():
                continue
            try:
                envelope = _read_model_usage_completion_envelope(pending_path)
                payload = envelope["payload"]
                completed = complete_model_usage_receipt(
                    payload["receiptId"],
                    usage={
                        "prompt_tokens": payload["promptTokens"],
                        "completion_tokens": payload["completionTokens"],
                        "total_tokens": payload["totalTokens"],
                    },
                    provider_ref=payload["providerRef"],
                    provider=payload["provider"],
                    model=payload["model"],
                    calls=payload["calls"],
                    output_units=payload["outputUnits"],
                    unit_label=payload["unitLabel"],
                    event_at=payload["eventAt"] or None,
                    now_ms=payload["completedAt"] or None,
                )
                result["completed"] += 1
                projected = reconcile_model_usage_outbox(receipt_id=payload["receiptId"])
                if projected.get("failed"):
                    raise ModelUsageCompletionSpoolError(
                        "model usage outbox projection failed"
                    )
                current = get_model_usage_receipt(payload["receiptId"])
                if not current or current.get("outboxState") != "projected":
                    raise ModelUsageCompletionSpoolError(
                        "model usage outbox projection remains pending"
                    )
                result["projected"] += int(projected.get("projected") or 0)
                reused_archive = _archive_model_usage_completion(
                    paths, pending_path, envelope
                )
                result["archived"] += 1
                result["archiveReused"] += int(reused_archive)
            except FileNotFoundError:
                continue
            except ModelUsageCompletionSpoolCorrupt:
                result["corrupt"] += 1
            except (ModelUsageCompletionSpoolConflict, ModelUsageReceiptConflict):
                result["conflicts"] += 1
            except (
                ModelUsageReceiptWriteError,
                ModelUsageCompletionSpoolError,
                StoreNotReadyError,
                sqlite3.Error,
                OSError,
                ValueError,
            ):
                result["failed"] += 1
    status = model_usage_completion_spool_status(spool_dir=spool_dir)
    result["pendingAfter"] = status["pending"]
    result["corruptAfter"] = status["corrupt"]
    result["conflictsAfter"] = status["conflicts"]
    return result


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
                "WHERE m.role IN ('admin','editor','user') "
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
                "WHERE m.role IN ('admin','editor','user') "
                "GROUP BY m.id,m.name,m.username,m.role,u.api_type"
            ).fetchall()
            receipt_rows = conn.execute(
                "SELECT m.id,m.name,m.username,m.role,r.usage_kind,COUNT(r.receipt_id),"
                "COALESCE(SUM(r.output_units),0),"
                "COALESCE(SUM(CASE WHEN r.usage_kind='llm' AND r.total_tokens=0 "
                "THEN 1 ELSE 0 END),0),"
                "COALESCE(SUM(CASE WHEN NOT (COALESCE(o.state,'')='projected' AND "
                "COALESCE(o.legacy_event_kind,'')=CASE WHEN r.usage_kind='llm' "
                "THEN 'llm_usage_events' ELSE 'api_usage_events' END) "
                "THEN r.calls ELSE 0 END),0),"
                "COALESCE(SUM(CASE WHEN NOT (COALESCE(o.state,'')='projected' AND "
                "COALESCE(o.legacy_event_kind,'')='api_usage_events') "
                "THEN r.output_units ELSE 0 END),0),"
                "COALESCE(SUM(CASE WHEN r.usage_kind='llm' AND NOT ("
                "COALESCE(o.state,'')='projected' AND "
                "COALESCE(o.legacy_event_kind,'')='llm_usage_events') "
                "THEN r.prompt_tokens ELSE 0 END),0),"
                "COALESCE(SUM(CASE WHEN r.usage_kind='llm' AND NOT ("
                "COALESCE(o.state,'')='projected' AND "
                "COALESCE(o.legacy_event_kind,'')='llm_usage_events') "
                "THEN r.completion_tokens ELSE 0 END),0),"
                "COALESCE(SUM(CASE WHEN r.usage_kind='llm' AND NOT ("
                "COALESCE(o.state,'')='projected' AND "
                "COALESCE(o.legacy_event_kind,'')='llm_usage_events') "
                "THEN r.total_tokens ELSE 0 END),0),MAX(r.event_at) "
                "FROM members m JOIN model_usage_receipts r ON r.member_id=m.id "
                "LEFT JOIN model_usage_outbox o ON o.receipt_id=r.receipt_id "
                "WHERE m.role IN ('admin','editor','user') AND r.call_status='succeeded' "
                "GROUP BY m.id,m.name,m.username,m.role,r.usage_kind"
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
    for (
        member_id, member_name, username, role, usage_kind, confirmed_calls,
        confirmed_outputs, token_unknown, missing_calls, missing_outputs,
        missing_prompt, missing_completion, missing_total, last_used_at,
    ) in receipt_rows:
        row = rows.setdefault(member_id, {
            "memberId": member_id, "memberName": member_name, "username": username,
            "role": role, "promptTokens": 0, "completionTokens": 0,
            "totalTokens": 0, "calls": 0, "lastUsedAt": None,
        })
        if usage_kind == "llm":
            row["confirmedLlmCalls"] = int(confirmed_calls or 0)
            row["tokenUnknownCalls"] = int(token_unknown or 0)
            row["calls"] = int(row.get("calls") or 0) + int(missing_calls or 0)
            row["promptTokens"] = int(row.get("promptTokens") or 0) + int(
                missing_prompt or 0
            )
            row["completionTokens"] = int(row.get("completionTokens") or 0) + int(
                missing_completion or 0
            )
            row["totalTokens"] = int(row.get("totalTokens") or 0) + int(
                missing_total or 0
            )
            row["lastUsedAt"] = max(
                int(row.get("lastUsedAt") or 0), int(last_used_at or 0)
            ) or None
            continue
        prefix = {"image": "image", "video": "video", "voice": "voice"}.get(
            usage_kind, ""
        )
        if not prefix:
            continue
        title_prefix = prefix.title()
        row[f"confirmed{title_prefix}Calls"] = int(confirmed_calls or 0)
        row[f"confirmed{title_prefix}Outputs"] = int(confirmed_outputs or 0)
        row[f"{prefix}Calls"] = int(row.get(f"{prefix}Calls") or 0) + int(
            missing_calls or 0
        )
        row[f"{prefix}Outputs"] = int(row.get(f"{prefix}Outputs") or 0) + int(
            missing_outputs or 0
        )
        row[f"{prefix}LastUsedAt"] = max(
            int(row.get(f"{prefix}LastUsedAt") or 0), int(last_used_at or 0)
        ) or None
    for row in rows.values():
        for key in ("imageCalls", "imageOutputs", "videoCalls", "videoOutputs", "voiceCalls", "voiceOutputs"):
            row.setdefault(key, 0)
        row.setdefault("confirmedLlmCalls", 0)
        row.setdefault("tokenUnknownCalls", 0)
        for prefix in ("Image", "Video", "Voice"):
            row.setdefault(f"confirmed{prefix}Calls", 0)
            row.setdefault(f"confirmed{prefix}Outputs", 0)
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
                "ORDER BY u.created_at DESC,u.rowid DESC LIMIT ?",
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
    receipt_where = "WHERE r.member_id=?" if member_id else ""
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
            receipt_rows = conn.execute(
                "SELECT r.usage_kind,r.surface,r.feature,COALESCE(r.model,''),r.call_status,"
                "COUNT(r.receipt_id),COALESCE(SUM(r.prompt_tokens),0),"
                "COALESCE(SUM(r.completion_tokens),0),COALESCE(SUM(r.total_tokens),0),"
                "COALESCE(SUM(r.output_units),0),"
                "COALESCE(SUM(CASE WHEN r.usage_kind='llm' AND r.call_status='succeeded' "
                "AND r.total_tokens=0 THEN 1 ELSE 0 END),0),MAX(r.updated_at) "
                "FROM model_usage_receipts r " + receipt_where + " "
                "GROUP BY r.usage_kind,r.surface,r.feature,COALESCE(r.model,''),r.call_status "
                "ORDER BY MAX(r.updated_at) DESC,r.usage_kind,r.feature",
                params,
            ).fetchall()
            receipt_events = conn.execute(
                "SELECT r.receipt_id,r.member_id,r.member_name,COALESCE(m.username,''),"
                "r.team_id,r.surface,r.feature,r.usage_kind,r.provider,r.model,r.operation,"
                "r.operation_id,r.idempotency_key,r.provider_ref,r.call_status,"
                "r.prompt_tokens,r.completion_tokens,r.total_tokens,r.calls,r.output_units,"
                "r.unit_label,r.source,r.error,r.event_at,r.created_at,r.updated_at,"
                "COALESCE(o.state,'') FROM model_usage_receipts r "
                "LEFT JOIN members m ON m.id=r.member_id "
                "LEFT JOIN model_usage_outbox o ON o.receipt_id=r.receipt_id " +
                receipt_where + " ORDER BY r.updated_at DESC LIMIT ?",
                (*params, limit),
            ).fetchall()
            unresolved_events = [
                row for row in receipt_events
                if row[14] in {"pending", "unknown"}
                or (row[14] == "succeeded" and row[26] != "projected")
            ]
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
    details["receiptRows"] = [{
        "usageKind": row[0], "surface": row[1], "feature": row[2], "model": row[3],
        "status": row[4], "calls": int(row[5] or 0),
        "promptTokens": int(row[6] or 0), "completionTokens": int(row[7] or 0),
        "totalTokens": int(row[8] or 0), "outputUnits": int(row[9] or 0),
        "tokenUnknownCalls": int(row[10] or 0), "lastUpdatedAt": row[11],
    } for row in receipt_rows]

    def receipt_event(row):
        return {
            "receiptId": row[0], "memberId": row[1], "memberName": row[2],
            "username": row[3], "teamId": row[4], "surface": row[5],
            "feature": row[6], "usageKind": row[7], "provider": row[8],
            "model": row[9], "operation": row[10], "operationId": row[11],
            "idempotencyKey": row[12], "providerRef": row[13], "status": row[14],
            "promptTokens": int(row[15] or 0), "completionTokens": int(row[16] or 0),
            "totalTokens": int(row[17] or 0), "calls": int(row[18] or 0),
            "outputUnits": int(row[19] or 0), "unitLabel": row[20] or "",
            "source": row[21], "error": row[22] or "", "eventAt": row[23],
            "createdAt": row[24], "updatedAt": row[25], "outboxState": row[26],
            "tokenUsageKnown": bool(row[7] != "llm" or int(row[17] or 0) > 0),
        }

    details["receiptEvents"] = [receipt_event(row) for row in receipt_events]
    details["unresolvedReceiptEvents"] = [
        receipt_event(row) for row in unresolved_events
    ]
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


def _upsert_docs_in_conn(conn, collection, items, *, actor_id=""):
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
                "exposureUpdatedAt", "exposureUpdatedBy", "exposureCount",
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
        _ensure_doc_resource_scope_locked(
            conn,
            collection,
            doc_id,
            it,
            actor_id=actor_id,
            owner_id=str(it.get("ownerId") or actor_id or ""),
        )
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


def upsert_docs(collection, items, *, actor_id=""):
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            written = _upsert_docs_in_conn(
                conn, collection, items, actor_id=actor_id
            )
            conn.commit()
            return written
        finally:
            conn.close()


def list_publish_tags(member_id):
    """发布标签在当前租户内共享，不混入前端全量状态集合。"""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id,data FROM docs WHERE collection='publishTags' "
                "ORDER BY updated_at ASC, rowid ASC"
            ).fetchall()
            items = []
            for doc_id, raw in rows:
                if not _resource_scope_allows_actor_locked(
                    conn, "publishTags", doc_id, member_id
                ):
                    continue
                try:
                    item = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                label = re.sub(r"\s+", " ", str(item.get("label") or "")).strip()[:20]
                if label:
                    items.append({**item, "label": label})
            return items
        finally:
            conn.close()


def create_publish_tag(label, member_id):
    clean = re.sub(r"\s+", " ", str(label or "")).strip()[:20]
    if not clean:
        raise ValueError("empty_publish_tag")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id,data FROM docs WHERE collection='publishTags'"
            ).fetchall()
            wanted = clean.casefold()
            for doc_id, raw in rows:
                if not _resource_scope_allows_actor_locked(
                    conn, "publishTags", doc_id, member_id
                ):
                    continue
                try:
                    existing = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if str(existing.get("label") or "").strip().casefold() == wanted:
                    return existing
            now = int(time.time() * 1000)
            item = {
                "id": f"publish-tag-{uuid.uuid4().hex[:12]}",
                "label": clean,
                "createdBy": str(member_id or ""),
                "createdAt": now,
                "updatedAt": now,
            }
            _ensure_doc_resource_scope_locked(
                conn,
                "publishTags",
                item["id"],
                item,
                actor_id=member_id,
                owner_id=member_id,
            )
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("publishTags", item["id"], None, now, json.dumps(item, ensure_ascii=False)),
            )
            conn.commit()
            return item
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


def _resource_scope_row_locked(conn, collection, resource_id):
    if not _resource_scopes_enforced_locked(conn):
        return None
    return conn.execute(
        "SELECT scope_type,scope_id,owner_id FROM resource_scopes "
        "WHERE resource_kind=? AND resource_id=?",
        (_doc_resource_kind(collection), str(resource_id)),
    ).fetchone()


def _resource_scope_allows_actor_locked(
    conn, collection, resource_id, member_id, role=None, parent_id=None,
):
    if not _resource_scopes_enforced_locked(conn):
        return True
    stored = _resource_scope_row_locked(conn, collection, resource_id)
    if not stored:
        return False
    actor = _member_resource_scope_locked(conn, member_id)
    if not actor:
        return False
    return (str(stored[0]), str(stored[1])) == (actor[0], actor[1])


def _ensure_doc_resource_scope_locked(
    conn, collection, resource_id, payload, *, actor_id="", owner_id="",
):
    """Attach a new write to exactly one actor tenant once v140 is active."""

    if not _resource_scopes_enforced_locked(conn):
        return
    clean_resource_id = str(resource_id or "")
    if not clean_resource_id:
        raise PermissionError("resource_scope_required")
    actor = _member_resource_scope_locked(conn, actor_id or owner_id)
    if not actor:
        raise PermissionError("resource_scope_required")
    actor_key = (actor[0], actor[1])
    existing = _resource_scope_row_locked(conn, collection, clean_resource_id)
    if existing:
        if (str(existing[0]), str(existing[1])) != actor_key:
            raise PermissionError("resource_scope_conflict")
    item = payload if isinstance(payload, dict) else {}
    candidates = {actor_key}
    for field in _RESOURCE_SCOPE_MEMBER_FIELDS:
        for identity in dict.fromkeys(_resource_values(item.get(field))):
            member_scope = _member_resource_scope_locked(conn, identity)
            if not member_scope:
                raise PermissionError("resource_member_scope_missing")
            candidates.add((member_scope[0], member_scope[1]))
    account_ids = []
    if collection == "accounts":
        account_ids.append(clean_resource_id)
    for field in _RESOURCE_SCOPE_ACCOUNT_FIELDS:
        account_ids.extend(_resource_values(item.get(field)))
    for account_id in dict.fromkeys(account_ids):
        account_scope = _account_resource_scope_locked(conn, account_id)
        if account_scope:
            candidates.add((account_scope[0], account_scope[1]))
        elif collection != "accounts":
            raise PermissionError("resource_account_scope_missing")
    for field, target_collection in _RESOURCE_SCOPE_REFERENCE_FIELDS.get(collection, ()):
        for target_id in _resource_values(item.get(field)):
            target = _resource_scope_row_locked(conn, target_collection, target_id)
            if not target:
                raise PermissionError("resource_reference_scope_missing")
            candidates.add((str(target[0]), str(target[1])))
    if candidates != {actor_key}:
        raise PermissionError("resource_scope_conflict")
    if existing:
        return
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO resource_scopes("
        "resource_kind,resource_id,scope_type,scope_id,owner_id,provenance,"
        "captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        (
            _doc_resource_kind(collection), clean_resource_id,
            actor[0], actor[1], str(owner_id or actor[2] or ""),
            "v140-write-actor", now, now,
        ),
    )


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
    if role == "admin" or collection in ADMIN_ONLY_GENERIC_COLLECTIONS:
        _ensure_db()
        with _lock:
            conn = _connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                team_row = conn.execute(
                    "SELECT t.id,t.name,t.kind,t.status,t.plan,t.quota_mode,tm.team_role "
                    "FROM team_members tm JOIN teams t ON t.id=tm.team_id "
                    "WHERE tm.member_id=? AND tm.status='active' AND t.status='active'",
                    (str(owner_id),),
                ).fetchone()
                team = _team_public_row(team_row)
                team_manager = bool(
                    team and team.get("role") in {"owner", "admin"}
                )
                elevated_team_admin = (
                    team_manager and collection in ADMIN_ONLY_GENERIC_COLLECTIONS
                )
                if role == "admin" or elevated_team_admin:
                    if collection == "products" and (
                        not team or team.get("id") != INTERNAL_TEAM_ID
                    ):
                        raise PermissionError("forbidden")
                    incoming_ids = {
                        str(item.get("id"))
                        for item in (items or [])
                        if isinstance(item, dict) and item.get("id")
                    }
                    if collection == "accounts" and team and incoming_ids:
                        marks = ",".join("?" for _ in incoming_ids)
                        rows = conn.execute(
                            f"SELECT account_id,team_id FROM team_accounts "
                            f"WHERE account_id IN ({marks})",
                            tuple(sorted(incoming_ids)),
                        ).fetchall()
                        if any(
                            str(team_id) != str(team["id"])
                            for _account_id, team_id in rows
                        ):
                            raise PermissionError("forbidden")
                    written = _upsert_docs_in_conn(
                        conn, collection, items, actor_id=owner_id
                    )
                    if collection == "accounts" and team:
                        now = int(time.time() * 1000)
                        for account_id in sorted(incoming_ids):
                            conn.execute(
                                "INSERT OR IGNORE INTO team_accounts("
                                "team_id,account_id,created_at,added_by) "
                                "VALUES(?,?,?,?)",
                                (team["id"], account_id, now, owner_id),
                            )
                    conn.commit()
                    return {"written": written, "denied": 0, "unchanged": 0}
                conn.rollback()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
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
            written = _upsert_docs_in_conn(
                conn, collection, allowed, actor_id=owner_id
            )
            conn.commit()
            return {"written": written, "denied": denied, "unchanged": unchanged}
        finally:
            conn.close()


def upsert_member_assets(owner_id, role, items):
    """创作成员只能新建/更新自己的私有资产；管理员仅能管理本团队资产。

    前端保存 assets 时会携带当前快照中的共享 BGM 等其他成员记录，所以对完全
    未改变的他人记录只跳过，不把一次正常保存误判为越权；任何字段变化仍拒绝。
    """
    if role == "admin":
        actor = str(owner_id)
        team = member_team(actor)
        if not team:
            raise PermissionError("forbidden")
        team_id = str(team.get("id") or "")
        member_ids = team_member_ids(team_id)
        account_ids = team_account_ids(team_id)
        incoming = [
            dict(item) for item in (items or [])
            if isinstance(item, dict) and item.get("id")
        ]
        _ensure_db()
        with _lock:
            conn = _connect()
            try:
                allowed = []
                denied = 0
                unchanged = 0
                for item in incoming:
                    doc_id = str(item["id"])
                    row = conn.execute(
                        "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                        (doc_id,),
                    ).fetchone()
                    existing = {}
                    stored_owner = ""
                    existing_account = ""
                    if row:
                        try:
                            existing = json.loads(row[1])
                        except (TypeError, json.JSONDecodeError):
                            existing = {}
                        stored_owner = str(row[0] or existing.get("ownerId") or "")
                        existing_account = str(existing.get("accountId") or "")
                        legacy_acg = (
                            team_id == INTERNAL_TEAM_ID
                            and stored_owner in {"", DEFAULT_ADMIN_USERNAME}
                        )
                        existing_in_team = (
                            stored_owner in member_ids
                            or existing_account in account_ids
                            or legacy_acg
                        )
                        if not existing_in_team:
                            if _same_doc_payload(existing, item):
                                unchanged += 1
                            else:
                                denied += 1
                            continue

                    incoming_owner = str(item.get("ownerId") or "")
                    incoming_account = str(item.get("accountId") or "")
                    if incoming_owner and incoming_owner not in member_ids:
                        denied += 1
                        continue
                    if incoming_account and incoming_account not in account_ids:
                        denied += 1
                        continue
                    # Preserve a same-team owner's identity on updates; every new
                    # accountless asset is explicitly attached to its creator so
                    # it can never become an ambiguous cross-tenant record.
                    item["ownerId"] = stored_owner if stored_owner in member_ids else actor
                    allowed.append(item)
                if denied and not allowed:
                    raise PermissionError("forbidden")
                written = _upsert_docs_in_conn(
                    conn, "assets", allowed, actor_id=owner_id
                )
                conn.commit()
                return {"written": written, "denied": denied, "unchanged": unchanged}
            finally:
                conn.close()
    if role not in {"editor", "user"}:
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
        "written": (
            upsert_docs("assets", allowed, actor_id=owner_id) if allowed else 0
        ),
        "denied": denied,
    }


SUPPLIER_ASSET_IMMUTABLE_FIELDS = {
    "id", "accountId", "ownerId", "byMemberId", "delivered", "shared",
    "productionId", "customProjectId", "sourceOutputId", "sourceItemIds",
    "deliveryId", "coverAssetId", "packAssetIds",
}


def upsert_supplier_assets(member_id, role, items):
    """Tenant-scoped compatibility writer for supplier delivery snapshots.

    Suppliers may only update already persisted delivery rows associated with
    an account in their mapped team (and, for a child, explicitly assigned to
    that child).  Tenant/provenance fields always come from the stored row, so
    a full-browser snapshot cannot move an asset between accounts or tenants.
    """
    incoming = [
        dict(item) for item in (items or [])
        if isinstance(item, dict) and item.get("id")
    ]
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            context = _supplier_access_context_locked(conn, member_id, role)
            if not context:
                conn.rollback()
                raise PermissionError("forbidden")
            allowed = []
            denied = 0
            unchanged = 0
            for item in incoming:
                doc_id = str(item["id"])
                row = conn.execute(
                    "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                    (doc_id,),
                ).fetchone()
                if not row:
                    denied += 1
                    continue
                try:
                    existing = json.loads(row[1])
                except (TypeError, json.JSONDecodeError):
                    denied += 1
                    continue
                if (
                    (not existing.get("delivered") and not existing.get("shared"))
                    or not _supplier_asset_allowed_locked(conn, context, existing)
                    or str(item.get("accountId") or "") != str(existing.get("accountId") or "")
                ):
                    denied += 1
                    continue
                for key in SUPPLIER_ASSET_IMMUTABLE_FIELDS:
                    if key in existing:
                        item[key] = existing[key]
                    else:
                        item.pop(key, None)
                item["id"] = doc_id
                item["ownerId"] = row[0] if row[0] is not None else existing.get("ownerId")
                if _same_doc_payload(existing, item):
                    unchanged += 1
                    continue
                allowed.append(item)
            if denied and not allowed and not unchanged:
                conn.rollback()
                raise PermissionError("forbidden")
            written = _upsert_docs_in_conn(
                conn, "assets", allowed, actor_id=member_id
            )
            conn.commit()
            return {"written": written, "denied": denied, "unchanged": unchanged}
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def upsert_voice_presets(owner_id, role, items):
    """定制音色全平台可选，但只有原创建者或管理员能修改。"""
    if role not in {"admin", "editor", "user"}:
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
        upsert_docs("voicePresets", allowed, actor_id=owner_id)


def list_voice_presets(member_id):
    """Return the current tenant's custom voices for server-side integrations.

    Preview audio can be large and is irrelevant to TTS routing, so this helper
    deliberately returns only the safe metadata needed to select a voice ID.
    Team members may share a preset, while personal and external-team scopes
    remain isolated; callers must never fall back to a different tenant's row.
    """
    _ensure_db()
    presets = []
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id,owner_id,data,updated_at FROM docs "
                "WHERE collection='voicePresets'"
            ).fetchall()
            for doc_id, owner_id, raw_data, updated_at in rows:
                if not _resource_scope_allows_actor_locked(
                    conn, "voicePresets", doc_id, member_id,
                ):
                    continue
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
        finally:
            conn.close()
    return sorted(
        presets,
        key=lambda item: (item["updatedAt"], item["createdAt"], item["id"]),
        reverse=True,
    )


def delete_member_doc(collection, doc_id, member_id, role, protect_custom_delivery=False):
    """通用删除同样执行 actor 校验，避免 DELETE 绕过 PUT 的权限矩阵。

    租户范围、业务权限和最终 DELETE 必须位于同一个 BEGIN IMMEDIATE
    事务内。否则多进程下可在校验后删除前删除并以同 ID 重建另一
    租户资源，使旧 actor 跨租户删除新记录。
    """
    if collection not in COLLECTIONS:
        raise ValueError("unknown collection")
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            if not _resource_scope_allows_actor_locked(
                conn, collection, doc_id, member_id, role
            ):
                raise PermissionError("forbidden")

            team_row = conn.execute(
                "SELECT t.id,t.name,t.kind,t.status,t.plan,t.quota_mode,tm.team_role "
                "FROM team_members tm JOIN teams t ON t.id=tm.team_id "
                "WHERE tm.member_id=? AND tm.status='active' AND t.status='active'",
                (str(member_id),),
            ).fetchone()
            team = _team_public_row(team_row)
            team_manager = bool(
                team and team.get("role") in {"owner", "admin"}
            )
            elevated_team_admin = (
                team_manager and collection in ADMIN_ONLY_GENERIC_COLLECTIONS
            )
            if role == "admin" or elevated_team_admin:
                if collection == "products" and (
                    not team or team.get("id") != INTERNAL_TEAM_ID
                ):
                    raise PermissionError("forbidden")
                if collection == "accounts" and team:
                    owner_team = conn.execute(
                        "SELECT team_id FROM team_accounts WHERE account_id=?",
                        (str(doc_id),),
                    ).fetchone()
                    if not owner_team or str(owner_team[0]) != str(team["id"]):
                        raise PermissionError("forbidden")
                if collection == "productions":
                    job_rows = conn.execute(
                        "SELECT id,data FROM docs WHERE collection='jobs'"
                    ).fetchall()
                    for job_id, raw in job_rows:
                        try:
                            job = json.loads(raw)
                        except (TypeError, json.JSONDecodeError):
                            continue
                        if str(job.get("productionId") or "") != str(doc_id):
                            continue
                        if not _resource_scope_allows_actor_locked(
                            conn, "jobs", job_id, member_id, role
                        ):
                            raise PermissionError("resource_scope_conflict")
                        _delete_doc_in_conn(conn, "jobs", job_id)
                if collection == "assets":
                    _clear_legacy_style_reference_locked(conn, doc_id)
                _delete_doc_in_conn(
                    conn,
                    collection,
                    doc_id,
                    protect_custom_delivery=protect_custom_delivery,
                )
                if collection == "accounts":
                    conn.execute(
                        "DELETE FROM team_accounts WHERE account_id=?",
                        (str(doc_id),),
                    )
                conn.commit()
                return

            if role != "editor" or collection in ADMIN_ONLY_GENERIC_COLLECTIONS:
                raise PermissionError("forbidden")
            actor = str(member_id)
            row = _doc_row_in_conn(conn, collection, doc_id)
            if not row:
                conn.commit()
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
                        if not _resource_scope_allows_actor_locked(
                            conn, "jobs", job_id, member_id, role
                        ):
                            raise PermissionError("resource_scope_conflict")
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
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def can_write_asset_file(asset_id, member_id, role):
    """文件上传覆盖前检查同 ID 资产归属；新 ID 可由当前创作者创建。"""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            existing = conn.execute(
                "SELECT 1 FROM docs WHERE collection='assets' AND id=?",
                (str(asset_id),),
            ).fetchone()
            if _resource_scopes_enforced_locked(conn):
                if existing:
                    return _resource_scope_allows_actor_locked(
                        conn, "assets", asset_id, member_id, role
                    )
                return _member_resource_scope_locked(conn, member_id) is not None
        finally:
            conn.close()
    if role == "admin":
        return True
    if role in {"supplier_parent", "supplier"}:
        # 供应商管理员只能为之后由专用账号 API 绑定的新资产上传文件；
        # 已存在的资产仍不允许从通用文件口覆盖。
        if not supplier_access_context(member_id, role):
            return False
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
    if role != "editor":
        if role != "admin":
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
                    if _resource_scopes_enforced_locked(conn):
                        return _resource_scope_allows_actor_locked(
                            conn, "assets", asset_id, member_id, role
                        )
                    if role == "admin":
                        return True
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
    for asset_id, row_owner, raw in rows:
        if not _resource_scope_allows_actor_locked(
            conn, "assets", asset_id, owner,
        ):
            continue
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
        SELECT id,data
        FROM docs
        WHERE collection='customProjects' AND owner_id=?
        ORDER BY updated_at DESC
        """,
        (str(owner_id),),
    ).fetchall()
    for doc_id, raw in rows:
        if not _resource_scope_allows_actor_locked(
            conn, "customProjects", doc_id, owner_id,
        ):
            continue
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
                "SELECT id,data FROM docs WHERE collection='customProjects' "
                "AND owner_id=? ORDER BY updated_at DESC",
                (str(owner_id),),
            ).fetchall()
            items = []
            for doc_id, raw in rows:
                if not _resource_scope_allows_actor_locked(
                    conn, "customProjects", doc_id, owner_id,
                ):
                    continue
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
        _register_private_media_locked(
            conn,
            "canvas-blob",
            content_hash,
            owner,
            provenance_kind="custom-canvas-blob",
            provenance_id=content_hash,
            now=now,
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
    # A generation result is uploaded before its lightweight URL is committed
    # into the draft. Keep that short hand-off race owner-scoped and bounded.
    staging_cutoff = int(time.time() * 1000) - 24 * 60 * 60 * 1000
    conn.execute(
        "DELETE FROM custom_canvas_blob_staging WHERE owner_id=? AND created_at<?",
        (owner, staging_cutoff),
    )
    referenced.update(str(row[0]) for row in conn.execute(
        "SELECT content_hash FROM custom_canvas_blob_staging WHERE owner_id=?",
        (owner,),
    ).fetchall())
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
        conn.executemany(
            "DELETE FROM private_media_registry "
            "WHERE media_kind='canvas-blob' AND owner_id=? AND media_key=?",
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


def _custom_canvas_generation_receipt_token(payload):
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    encoded = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(
        _secret(),
        f"custom-canvas-generation:{encoded}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"{encoded}.{signature}"


def _custom_canvas_parse_generation_receipt(token):
    try:
        encoded, signature = str(token or "").strip().rsplit(".", 1)
        expected = hmac.new(
            _secret(),
            f"custom-canvas-generation:{encoded}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid_custom_canvas_generation_receipt")
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        if (
            not isinstance(payload, dict)
            or int(payload.get("version") or 0) != 1
            or not re.fullmatch(r"[a-f0-9]{32}", str(payload.get("receiptId") or ""))
            or not re.fullmatch(r"[a-f0-9]{64}", str(payload.get("contentHash") or ""))
            or int(payload.get("points") or 0) <= 0
        ):
            raise ValueError("invalid_custom_canvas_generation_receipt")
        return payload
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError("invalid_custom_canvas_generation_receipt") from exc


def _prepare_custom_canvas_generation_receipts(owner_id, receipt_specs, now):
    owner = str(owner_id or "")
    if not owner:
        raise ValueError("invalid_custom_canvas_generation_receipt")
    prepared = []
    for spec in list(receipt_specs or []):
        item = spec if isinstance(spec, dict) else {}
        parsed = _custom_canvas_parse_data_image(item.get("dataUrl"))
        if not parsed:
            raise ValueError("invalid_custom_canvas_image")
        amount = int(item.get("points") or 0)
        if amount <= 0:
            raise ValueError("invalid_custom_canvas_generation_receipt")
        payload = {
            "version": 1,
            "receiptId": uuid.uuid4().hex,
            "ownerId": owner,
            "contentHash": parsed["contentHash"],
            "points": amount,
            "feature": str(item.get("feature") or "无限画布图片生成")[:80],
            "expiresAt": int(now) + CUSTOM_CANVAS_GENERATION_RECEIPT_TTL_MS,
        }
        prepared.append({
            **payload,
            "token": _custom_canvas_generation_receipt_token(payload),
        })
    return prepared


def _insert_custom_canvas_generation_receipts_locked(conn, prepared, now, charged):
    for receipt in prepared:
        conn.execute(
            """
            INSERT INTO custom_canvas_generation_receipts(
              owner_id,receipt_id,content_hash,points,feature,
              expires_at,created_at,charged_at
            ) VALUES(?,?,?,?,?,?,?,?)
            """,
            (
                receipt["ownerId"],
                receipt["receiptId"],
                receipt["contentHash"],
                receipt["points"],
                receipt["feature"],
                receipt["expiresAt"],
                int(now),
                int(now) if charged else None,
            ),
        )


def issue_custom_canvas_generation_receipts(
    owner_id,
    receipt_specs,
    charged=False,
    now_ms=None,
):
    """Register a batch of exact outputs in one transaction."""
    now = int(now_ms if now_ms is not None else time.time() * 1000)
    prepared = _prepare_custom_canvas_generation_receipts(owner_id, receipt_specs, now)
    if not prepared:
        return []
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _insert_custom_canvas_generation_receipts_locked(
                conn, prepared, now, bool(charged),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
    return prepared


def issue_custom_canvas_generation_receipt(
    owner_id,
    data_url,
    points=5,
    feature="无限画布图片生成",
    charged=False,
    now_ms=None,
):
    """Register and sign one exact generated image before it reaches the client."""
    return issue_custom_canvas_generation_receipts(
        owner_id,
        [{"dataUrl": data_url, "points": points, "feature": feature}],
        charged=charged,
        now_ms=now_ms,
    )[0]


def mark_custom_canvas_generation_receipt_charged(owner_id, receipt_id, now_ms=None):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            result = conn.execute(
                """
                UPDATE custom_canvas_generation_receipts
                SET charged_at=COALESCE(charged_at,?)
                WHERE owner_id=? AND receipt_id=?
                """,
                (
                    int(now_ms if now_ms is not None else time.time() * 1000),
                    str(owner_id or ""),
                    str(receipt_id or ""),
                ),
            )
            conn.commit()
            return bool(result.rowcount)
        finally:
            conn.close()


def _custom_canvas_pending_generation_hashes_locked(conn, owner_id, hashes):
    digests = {
        str(value)
        for value in hashes
        if re.fullmatch(r"[a-f0-9]{64}", str(value or ""))
    }
    if not digests:
        return set()
    rows = conn.execute(
        """
        SELECT DISTINCT content_hash
        FROM custom_canvas_generation_receipts
        WHERE owner_id=? AND charged_at IS NULL AND content_hash IN (%s)
        """ % ",".join("?" for _ in digests),
        (str(owner_id or ""), *sorted(digests)),
    ).fetchall()
    return {str(row[0]) for row in rows}


def save_custom_canvas_blob(owner_id, data_url, generation_receipt=""):
    """Persist one owner-scoped image before a large draft PUT.

    The following project save validates ownership of the returned stable URL
    and makes it reachable from the draft. The short-lived staging row protects
    this hand-off from an older in-flight draft save. A model output additionally
    requires the owner/hash-bound signed receipt issued by the generation route.
    """
    parsed = _custom_canvas_parse_data_image(data_url)
    if not parsed:
        raise ValueError("invalid_custom_canvas_image")
    owner = str(owner_id or "")
    receipt_payload = None
    if str(generation_receipt or "").strip():
        receipt_payload = _custom_canvas_parse_generation_receipt(generation_receipt)
        if (
            str(receipt_payload.get("ownerId") or "") != owner
            or str(receipt_payload.get("contentHash") or "") != parsed["contentHash"]
            or int(receipt_payload.get("expiresAt") or 0) < int(time.time() * 1000)
        ):
            raise ValueError("invalid_custom_canvas_generation_receipt")
    _ensure_db()
    created_blob_files = []
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            generated = conn.execute(
                "SELECT 1 FROM custom_canvas_generation_receipts "
                "WHERE owner_id=? AND content_hash=? LIMIT 1",
                (owner, parsed["contentHash"]),
            ).fetchone()
            if generated and not receipt_payload:
                raise ValueError("custom_canvas_generation_receipt_required")
            if receipt_payload:
                receipt_row = conn.execute(
                    """
                    SELECT content_hash,points,feature,expires_at,charged_at
                    FROM custom_canvas_generation_receipts
                    WHERE owner_id=? AND receipt_id=?
                    """,
                    (owner, receipt_payload["receiptId"]),
                ).fetchone()
                if not receipt_row or (
                    str(receipt_row[0]) != parsed["contentHash"]
                    or int(receipt_row[1]) != int(receipt_payload["points"])
                    or str(receipt_row[2]) != str(receipt_payload["feature"])
                    or int(receipt_row[3]) != int(receipt_payload["expiresAt"])
                    or receipt_row[4] is None
                ):
                    raise ValueError("invalid_custom_canvas_generation_receipt")
            _persist_custom_canvas_blobs_locked(
                conn,
                owner,
                {parsed["contentHash"]: parsed},
                int(time.time() * 1000),
                created_blob_files,
            )
            conn.execute(
                """
                INSERT INTO custom_canvas_blob_staging(owner_id,content_hash,created_at)
                VALUES(?,?,?)
                ON CONFLICT(owner_id,content_hash) DO UPDATE SET
                  created_at=excluded.created_at
                """,
                (owner, parsed["contentHash"], int(time.time() * 1000)),
            )
            conn.commit()
            result = {
                "contentHash": parsed["contentHash"],
                "url": _custom_canvas_blob_url(parsed["contentHash"]),
                "mime": parsed["mime"],
                "size": parsed["size"],
            }
            if receipt_payload:
                result["generationReceipt"] = {
                    "receiptId": receipt_payload["receiptId"],
                    "points": int(receipt_payload["points"]),
                    "feature": str(receipt_payload["feature"]),
                    "chargedAt": int(receipt_row[4]),
                }
            return result
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
    _ensure_doc_resource_scope_locked(
        conn,
        "customProjects",
        custom_project_id,
        item,
        actor_id=owner,
        owner_id=owner,
    )
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
            incoming_hashes = set()
            _custom_canvas_collect_blob_hashes(prepared["project"], incoming_hashes)
            _custom_canvas_collect_blob_hashes(prepared["draft"], incoming_hashes)
            if _custom_canvas_pending_generation_hashes_locked(conn, owner, incoming_hashes):
                raise ValueError("custom_canvas_generation_receipt_required")
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
            committed_hashes = set()
            _custom_canvas_collect_blob_hashes(prepared["project"], committed_hashes)
            _custom_canvas_collect_blob_hashes(prepared["draft"], committed_hashes)
            if committed_hashes:
                conn.executemany(
                    "DELETE FROM custom_canvas_blob_staging WHERE owner_id=? AND content_hash=?",
                    [(owner, digest) for digest in committed_hashes],
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
            if not _resource_scope_allows_actor_locked(
                conn, "customProjects", project_id, owner_id,
            ):
                return None, "forbidden"
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


def get_custom_output_by_source(project_id, owner_id, source_output_id):
    """Resolve one video output by its server-owned project/source identity."""
    pid = str(project_id or "").strip()
    owner = str(owner_id or "").strip()
    output_id = str(source_output_id or "").strip()
    if not pid or not owner or not output_id:
        return None, "not_found"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute(
                "SELECT id,data FROM docs WHERE collection='customOutputs' AND owner_id=?",
                (owner,),
            ).fetchall()
            for doc_id, raw in rows:
                if not _resource_scope_allows_actor_locked(
                    conn, "customOutputs", doc_id, owner,
                ):
                    continue
                try:
                    item = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if not isinstance(item, dict) or str(item.get("projectId") or "") != pid:
                    continue
                if output_id not in {
                    str(doc_id or ""),
                    str(item.get("id") or ""),
                    str(item.get("sourceOutputId") or ""),
                }:
                    continue
                return item, None
            return None, "not_found"
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
            _ensure_doc_resource_scope_locked(
                conn,
                "customProjects",
                pid,
                item,
                actor_id=owner_id,
                owner_id=owner_id,
            )
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
            conn.execute("BEGIN IMMEDIATE")
            row = _custom_project_row(pid, conn)
            if not row:
                return None, "not_found"
            if not _resource_scope_allows_actor_locked(
                conn, "customProjects", pid, owner_id,
            ):
                return None, "forbidden"
            stored_owner, project = row
            if stored_owner != str(owner_id):
                return None, "forbidden"
            delivery_row = conn.execute(
                "SELECT data FROM docs WHERE collection='assets' AND id=?",
                (did,),
            ).fetchone()
            if not delivery_row:
                return None, "delivery_not_found"
            if not _resource_scope_allows_actor_locked(
                conn, "assets", did, owner_id,
            ):
                return None, "delivery_mismatch"
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
        except Exception:
            conn.rollback()
            raise
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
            if not _resource_scope_allows_actor_locked(
                conn, "customProjects", pid, owner,
            ):
                return None, "forbidden"
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
            if not _resource_scope_allows_actor_locked(
                conn, "accounts", account_id, owner,
            ):
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
                if not _resource_scope_allows_actor_locked(
                    conn, "assets", did, owner,
                ):
                    return None, "delivery_mismatch"
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
                "exposureUpdatedAt", "exposureUpdatedBy", "exposureCount",
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
                _ensure_doc_resource_scope_locked(
                    conn,
                    "assets",
                    asset_id,
                    asset,
                    actor_id=owner,
                    owner_id=owner,
                )
                conn.execute(
                    "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                    ("assets", asset_id, owner, now, json.dumps(asset, ensure_ascii=False)),
                )
            _ensure_doc_resource_scope_locked(
                conn,
                "assets",
                did,
                delivery,
                actor_id=owner,
                owner_id=owner,
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
            if not _resource_scope_allows_actor_locked(
                conn, "customProjects", pid, owner,
            ):
                return None, "forbidden"
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
            if not _resource_scope_allows_actor_locked(
                conn, "assets", did, owner,
            ):
                return None, "delivery_mismatch"
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
                if not _resource_scope_allows_actor_locked(
                    conn, "accounts", account_id, owner,
                ):
                    return None, "delivery_mismatch"
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
                if not _resource_scope_allows_actor_locked(
                    conn, "analyticsLinks", link_id, owner,
                ):
                    continue
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
                    if not _resource_scope_allows_actor_locked(
                        conn, "metricSnapshots", snapshot_id, owner,
                    ):
                        continue
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
                        if not _resource_scope_allows_actor_locked(
                            conn, "insightReports", report_id, owner,
                        ):
                            continue
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
            for asset_id, raw in conn.execute(
                "SELECT id,data FROM docs WHERE collection='assets'"
            ).fetchall():
                if not _resource_scope_allows_actor_locked(
                    conn, "assets", asset_id, owner,
                ):
                    continue
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
                if (
                    not asset_row
                    or asset_row[0] != owner
                    or not _resource_scope_allows_actor_locked(
                        conn, "assets", asset_id, owner,
                    )
                ):
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
                "SELECT id,data FROM docs WHERE collection='customProjects' AND owner_id=?",
                (str(owner_id),),
            ).fetchall()
            for doc_id, raw in rows:
                if not _resource_scope_allows_actor_locked(
                    conn, "customProjects", doc_id, owner_id,
                ):
                    continue
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
        upsert_docs("customOutputs", output_docs, actor_id=owner_id)
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
            conn.execute("BEGIN IMMEDIATE")
            row = _custom_project_row(project_id, conn)
            if not row:
                return False, "not_found"
            if not _resource_scope_allows_actor_locked(
                conn, "customProjects", project_id, owner_id,
            ):
                return False, "forbidden"
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
                        if not _resource_scope_allows_actor_locked(
                            conn, collection, doc_id, owner_id,
                        ):
                            return False, "forbidden"
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
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _delivery_asset_access(item, member_id, role, conn):
    if not isinstance(item, dict) or not item.get("delivered"):
        return False
    if _resource_scopes_enforced_locked(conn):
        asset_id = str(item.get("id") or "").strip()
        if not asset_id or not _resource_scope_allows_actor_locked(
            conn, "assets", asset_id, member_id,
        ):
            return False
    if role == "admin":
        return True
    if role in {"supplier_parent", "supplier_child", "supplier"}:
        context = _supplier_access_context_locked(conn, member_id, role)
        return _supplier_asset_allowed_locked(conn, context, item)
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


def get_delivery_asset_for_member(asset_id, member_id, role):
    """Read one delivery only when it belongs to or is visible to the member.

    Community sharing needs the actual delivery snapshot to prove that a
    composed media URL is referenced by the selected source.  Keep this check
    in the store so it uses the same delivery access rules as remarks and other
    delivery APIs.  Personal/team creators may always read their own delivery.
    """
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT owner_id,data FROM docs WHERE collection='assets' AND id=?",
                (str(asset_id or ""),),
            ).fetchone()
            if not row:
                return None, "not_found"
            try:
                item = json.loads(row[1])
            except (TypeError, json.JSONDecodeError):
                return None, "not_found"
            if not isinstance(item, dict) or not item.get("delivered"):
                return None, "forbidden"
            if _resource_scopes_enforced_locked(conn) and not (
                _resource_scope_allows_actor_locked(
                    conn, "assets", str(asset_id or ""), str(member_id or ""),
                )
            ):
                return None, "forbidden"
            owner_ids = {
                str(row[0] or ""),
                str(item.get("ownerId") or ""),
                str(item.get("byMemberId") or ""),
            }
            owns_delivery = str(member_id or "") in owner_ids
            supplier_role = role in {"supplier_parent", "supplier_child", "supplier"}
            if supplier_role and not _delivery_asset_access(item, member_id, role, conn):
                return None, "forbidden"
            if not supplier_role and not owns_delivery and not _delivery_asset_access(item, member_id, role, conn):
                return None, "forbidden"
            return item, None
        finally:
            conn.close()


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


def _supplier_delivery_row_locked(conn, asset_id, member_id, role):
    context = _supplier_access_context_locked(conn, member_id, role)
    if not context:
        return None, None, None, "forbidden"
    if _resource_scopes_enforced_locked(conn) and not (
        _resource_scope_allows_actor_locked(
            conn, "assets", str(asset_id), str(member_id), role
        )
    ):
        return context, None, None, "unassigned"
    row = conn.execute(
        "SELECT data,owner_id FROM docs WHERE collection='assets' AND id=?",
        (str(asset_id),),
    ).fetchone()
    if not row:
        return context, None, None, "not_found"
    try:
        item = json.loads(row[0])
    except (TypeError, json.JSONDecodeError):
        return context, row, None, "not_found"
    if not item.get("delivered") and not item.get("shared"):
        return context, row, item, "not_delivered"
    if not _supplier_asset_allowed_locked(conn, context, item):
        return context, row, item, "unassigned"
    return context, row, item, None


def _supplier_account_row_locked(conn, account_id, member_id, role):
    context = _supplier_access_context_locked(conn, member_id, role)
    if not context or context["role"] != "supplier_parent":
        return None, None, None, "forbidden"
    if _resource_scopes_enforced_locked(conn) and not (
        _resource_scope_allows_actor_locked(
            conn, "accounts", str(account_id), str(member_id), role
        )
    ):
        return context, None, None, "unassigned"
    if not _supplier_account_allowed_locked(conn, context, account_id):
        return context, None, None, "unassigned"
    row = conn.execute(
        "SELECT data,owner_id FROM docs WHERE collection='accounts' AND id=?",
        (str(account_id),),
    ).fetchone()
    if not row:
        return context, None, None, "not_found"
    try:
        item = json.loads(row[0])
    except (TypeError, json.JSONDecodeError):
        return context, row, None, "not_found"
    return context, row, item, None


def update_supplier_asset_views(asset_id, view_count, member_id, role):
    """供应商观看量专用写入：母账号可更新供应商端交付，子账号仅可更新已分配账号。"""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _context, row, item, error = _supplier_delivery_row_locked(
                conn, asset_id, member_id, role
            )
            if error:
                return None, error
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


def update_supplier_asset_exposure(asset_id, exposure_count, member_id, role):
    """供应商曝光量专用写入：权限与单条素材观看量保持一致，且不影响观看量汇总。"""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _context, row, item, error = _supplier_delivery_row_locked(
                conn, asset_id, member_id, role
            )
            if error:
                return None, error
            now = int(time.time() * 1000)
            item["exposureCount"] = max(0, int(exposure_count or 0))
            item["exposureUpdatedAt"] = now
            item["exposureUpdatedBy"] = member_id
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
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _context, row, item, error = _supplier_account_row_locked(
                conn, account_id, member_id, role
            )
            if error:
                return None, error
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
    try:
        normalized = _normalize_homepage_url(homepage_url)
    except ValueError:
        return None, "invalid_url"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _context, row, item, error = _supplier_account_row_locked(
                conn, account_id, member_id, role
            )
            if error:
                return None, error
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
            conn.execute("BEGIN IMMEDIATE")
            context = _supplier_access_context_locked(conn, member_id, "supplier_parent")
            if not context:
                conn.rollback()
                return None, "forbidden"
            mapping = conn.execute(
                "SELECT team_id FROM team_accounts WHERE account_id=?",
                (doc_id,),
            ).fetchone()
            if mapping and str(mapping[0]) != context["teamId"]:
                conn.rollback()
                return None, "forbidden"
            if not create and not _supplier_account_allowed_locked(conn, context, doc_id):
                conn.rollback()
                return None, "unassigned"
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
            _ensure_doc_resource_scope_locked(
                conn,
                "accounts",
                doc_id,
                candidate,
                actor_id=member_id,
                owner_id=member_id,
            )
            conn.execute(
                "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                ("accounts", doc_id, None, now, json.dumps(candidate, ensure_ascii=False)),
            )
            if create:
                conn.execute(
                    "INSERT INTO team_accounts(team_id,account_id,created_at,added_by) "
                    "VALUES(?,?,?,?)",
                    (context["teamId"], doc_id, now, member_id),
                )
            persisted_assets = []
            for asset in _supplier_account_assets(doc_id, assets, member_id):
                asset.setdefault("createdAt", now)
                asset["updatedAt"] = max(now, int(asset.get("updatedAt") or 0))
                _ensure_doc_resource_scope_locked(
                    conn,
                    "assets",
                    asset["id"],
                    asset,
                    actor_id=member_id,
                    owner_id=member_id,
                )
                conn.execute(
                    "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                    ("assets", asset["id"], None, asset["updatedAt"], json.dumps(asset, ensure_ascii=False)),
                )
                persisted_assets.append(asset)
            conn.commit()
            return {"account": candidate, "assets": persisted_assets}, None
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def mark_supplier_asset_downloaded(asset_id, member_id, role):
    """只有真实供应商下载会写入供应商下载状态；创作端下载不经过此函数。"""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _context, row, item, error = _supplier_delivery_row_locked(
                conn, asset_id, member_id, role
            )
            if error:
                return None, error
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
    try:
        normalized = _normalize_published_url(published_url)
    except ValueError:
        return None, None, "invalid_url"
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _context, asset_row, item, error = _supplier_delivery_row_locked(
                conn, asset_id, member_id, role
            )
            if error:
                return None, None, error

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
            _ensure_doc_resource_scope_locked(
                conn,
                "analyticsLinks",
                link_id,
                link,
                actor_id=member_id,
                owner_id=str(link_owner or member_id),
            )
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
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            _context, asset_row, item, error = _supplier_delivery_row_locked(
                conn, asset_id, member_id, role
            )
            if error:
                return None, None, error

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
    supplier_context = None
    if role in {"supplier_parent", "supplier_child", "supplier"}:
        supplier_context = supplier_access_context(member_id, role, parent_id)
        if not supplier_context:
            names = COLLECTIONS if requested is None else requested
            return {name: [] for name in names}
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
    team = member_team(member_id) if role not in {"supplier_parent", "supplier_child", "supplier"} else None
    team_id = team["id"] if team else supplier_context["teamId"] if supplier_context else None
    visible_team_account_ids = team_account_ids(team_id)
    visible_team_member_ids = team_member_ids(team_id)
    supplier_allowed_account_ids = (
        assigned_account_ids if role == "supplier_child" else visible_team_account_ids
    )
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
                    if str(production.get("accountId") or "") not in supplier_allowed_account_ids:
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
                    f"SELECT id,data,owner_id FROM docs WHERE collection=?{account_order}",
                    (col,),
                ).fetchall()
                items = []
                if col == "accounts":
                    decoded_rows = [
                        (str(doc_id), json.loads(data), owner)
                        for doc_id, data, owner in rows
                    ]
                    account_projected_sequences = _projected_account_sequences(
                        [item for _doc_id, item, _owner in decoded_rows]
                    )
                    row_items = decoded_rows
                elif col == "assets":
                    decoded_rows = [
                        (str(doc_id), json.loads(data), owner)
                        for doc_id, data, owner in rows
                    ]
                    delivery_projected_sequences = _projected_delivery_sequences(
                        [item for _doc_id, item, _owner in decoded_rows]
                    )
                    delivery_global_sequences = _global_delivery_sequences(
                        [item for _doc_id, item, _owner in decoded_rows]
                    )
                    if role == "editor":
                        for _doc_id, delivery, _owner in decoded_rows:
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
                    row_items = (
                        (str(doc_id), json.loads(data), owner)
                        for doc_id, data, owner in rows
                    )
                for doc_id, item, owner in row_items:
                    if not _resource_scope_allows_actor_locked(
                        conn, col, doc_id, member_id, role, parent_id
                    ):
                        continue
                    healed = False
                    if col == "productions":
                        item, healed = _heal_production_runtime_state(item)
                    if col in {
                        "sessions", "batches",
                        "customProjects", "customOutputs", "customVideoJobs",
                    } and owner and owner != member_id:
                        continue
                    if col == "products" and (
                        role == "user"
                        or (team_id and team_id != INTERNAL_TEAM_ID)
                    ):
                        continue
                    if (
                        col == "accounts"
                        and role != "supplier_child"
                        and (
                            role == "user"
                            or (
                                team_id
                                and str(item.get("id") or "") not in visible_team_account_ids
                            )
                        )
                    ):
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
                        account_id = str(item.get("accountId") or "")
                        if role in {"supplier_parent", "supplier_child"} and account_id not in supplier_allowed_account_ids:
                            continue
                        if role == "user" and (
                            owner != member_id
                            or item.get("delivered")
                            or item.get("shared")
                            or _is_global_editing_asset(item)
                        ):
                            continue
                        if team_id and role not in {"supplier_parent", "supplier_child"}:
                            same_team_owner = bool(owner and str(owner) in visible_team_member_ids)
                            same_team_account = bool(account_id and account_id in visible_team_account_ids)
                            legacy_acg_asset = (
                                team_id == INTERNAL_TEAM_ID
                                and str(owner or item.get("ownerId") or "")
                                in {"", DEFAULT_ADMIN_USERNAME}
                            )
                            if not same_team_owner and not same_team_account and not legacy_acg_asset:
                                continue
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
                            and str(owner) not in visible_team_member_ids
                            and str(item.get("id") or "") not in editor_account_asset_ids
                            and str(item.get("id") or "") not in editor_delivery_asset_ids
                        ):
                            continue
                        if role not in {"supplier_child", "supplier_parent", "editor", "admin"} and owner and owner != member_id and not item.get("delivered") and not item.get("shared") and not _is_global_editing_asset(item):
                            continue
                    if (
                        healed
                        and col == "productions"
                        and not runtime_config.is_read_only()
                    ):
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
            if not runtime_config.is_read_only():
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


# ---------- 社区灵感（用户显式分享的轻量公开快照） ----------
COMMUNITY_CATEGORIES = {"视频灵感", "视觉设计"}
COMMUNITY_SOURCE_KINDS = {"video", "canvas", "delivery"}
COMMUNITY_MEDIA_PREFIXES = (
    "/api/files/",
    "/api/custom-canvas/blobs/",
    "/api/video/composed/",
    "/custom-video/outputs/",
)
_COMMUNITY_MEDIA_COMPONENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")


def normalize_community_media_url(value):
    """Return one canonical in-platform media path, or an empty string.

    Prefix checks alone are not sufficient here: query strings, encoded path
    separators and dot segments can otherwise make the ownership check inspect
    a different file from the one later served by the public community route.
    Generated platform file names and video-workshop project ids are all simple
    ASCII components, so reject ambiguous encodings instead of normalizing them.
    """
    url = str(value or "").strip()
    if not url or len(url) > 1200 or "\\" in url or "%" in url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme or parsed.netloc or parsed.params or parsed.query or parsed.fragment:
        return ""
    path = parsed.path
    if path != url or not path.startswith(COMMUNITY_MEDIA_PREFIXES):
        return ""
    if path.startswith("/api/custom-canvas/blobs/"):
        digest = path[len("/api/custom-canvas/blobs/"):]
        return path if re.fullmatch(r"[0-9a-f]{64}", digest) else ""
    for prefix in ("/api/files/", "/api/video/composed/"):
        if path.startswith(prefix):
            name = path[len(prefix):]
            return path if _COMMUNITY_MEDIA_COMPONENT_RE.fullmatch(name or "") else ""
    relative = path[len("/custom-video/outputs/"):]
    parts = relative.split("/")
    if len(parts) < 2 or any(
        part in {"", ".", ".."} or not _COMMUNITY_MEDIA_COMPONENT_RE.fullmatch(part)
        for part in parts
    ):
        return ""
    return path


def normalize_community_media(items):
    """只保存站内持久化 URL 和尺寸元数据，拒绝 Base64/blob/外链。"""
    clean = []
    for raw in list(items or [])[:20]:
        if not isinstance(raw, dict):
            continue
        url = normalize_community_media_url(raw.get("url"))
        if not url:
            continue
        kind = str(raw.get("type") or "").strip().lower()
        if kind not in {"image", "video"}:
            kind = "video" if re.search(r"\.(?:mp4|webm|mov)(?:\?|$)", url, re.I) else "image"
        try:
            width = max(0, min(20000, int(raw.get("width") or 0)))
            height = max(0, min(20000, int(raw.get("height") or 0)))
        except (TypeError, ValueError):
            width, height = 0, 0
        clean.append({
            "url": url,
            "type": kind,
            "width": width,
            "height": height,
            "alt": str(raw.get("alt") or "")[:160],
        })
    if not clean:
        raise ValueError("community_media_required")
    return clean


def normalize_community_cover(value):
    """视频封面独立保存，避免把封面误当作正文图片。"""
    raw = value if isinstance(value, dict) else {}
    if not raw:
        return {}
    clean = normalize_community_media([{**raw, "type": "image"}])
    return clean[0] if clean else {}


def community_delivery_media_urls(delivery, author_id):
    """Resolve the server-owned media closure of one delivery snapshot."""
    source = delivery if isinstance(delivery, dict) else {}
    owner = str(author_id or "")
    asset_ids = {
        str(source.get("sourceAssetId") or "").strip(),
        str(source.get("coverAssetId") or "").strip(),
        *[
            str(item or "").strip()
            for item in list(source.get("packAssetIds") or [])[:20]
        ],
    }
    asset_ids.discard("")
    payloads = [source]
    if asset_ids:
        _ensure_db()
        with _lock:
            conn = _connect()
            try:
                placeholders = ",".join("?" for _ in asset_ids)
                rows = conn.execute(
                    f"SELECT owner_id,data FROM docs WHERE collection='assets' "
                    f"AND id IN ({placeholders})",
                    tuple(sorted(asset_ids)),
                ).fetchall()
            finally:
                conn.close()
        for stored_owner, raw in rows:
            try:
                item = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            item_owners = {
                str(stored_owner or ""),
                str(item.get("ownerId") or "") if isinstance(item, dict) else "",
                str(item.get("byMemberId") or "") if isinstance(item, dict) else "",
            }
            if isinstance(item, dict) and owner in item_owners:
                payloads.append(item)

    found = set()

    def visit(value):
        if isinstance(value, dict):
            for child in value.values():
                visit(child)
        elif isinstance(value, (list, tuple)):
            for child in value:
                visit(child)
        elif isinstance(value, str):
            normalized = normalize_community_media_url(value)
            if normalized:
                found.add(normalized)

    visit(payloads)
    return found


def community_media_fingerprint(media):
    """Build the fallback identity from canonical URLs only.

    Media type is presentation metadata supplied by the browser.  Letting it
    participate in identity would allow the same persisted file to be shared
    twice merely by relabelling image/video.
    """
    payload = sorted({
        str(item.get("url") or "").strip()
        for item in list(media or [])
        if isinstance(item, dict) and item.get("url")
    })
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_community_source_identity(value):
    """Normalize a server-verified source identity shared by every UI surface.

    Delivery can materialize a workshop/canvas output under a different media
    URL, so URL fingerprints alone are not authoritative.  The caller must
    derive this structure from an owned project/output or delivery snapshot;
    the store only canonicalizes the already verified values.
    """
    raw = value if isinstance(value, dict) else {}
    kind = str(raw.get("kind") or "").strip().lower()
    project_id = str(raw.get("projectId") or "").strip()[:180]
    output_ids = {
        str(raw.get("sourceOutputId") or "").strip()[:180],
        *[
            str(item or "").strip()[:180]
            for item in list(raw.get("sourceItemIds") or [])[:20]
        ],
    }
    output_ids.discard("")
    if kind not in {"video", "canvas"} or not project_id or not output_ids:
        return {}
    return {
        "kind": kind,
        "projectId": project_id,
        "outputIds": sorted(output_ids),
    }


def community_identity_key(
    source_kind,
    source_id,
    media,
    cover=None,
    source_identity=None,
):
    return community_identity_keys(
        source_kind,
        source_id,
        media,
        cover,
        source_identity=source_identity,
    )[0]


def community_identity_keys(
    source_kind,
    source_id,
    media,
    cover=None,
    source_identity=None,
):
    """Return one primary identity plus per-output aliases.

    A canvas gallery and one of its individual images are the same already
    shared source for duplicate prevention.  Persist each item alias so either
    direction (gallery first or single image first) resolves transactionally.
    """
    verified = normalize_community_source_identity(source_identity)
    if verified:
        def source_key(output_ids):
            canonical = json.dumps(
                {**verified, "outputIds": sorted(output_ids)},
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            return "source:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()

        primary = source_key(verified["outputIds"])
        aliases = {primary, *(source_key([item]) for item in verified["outputIds"])}
        return primary, sorted(aliases)
    # Old records and outputs without stable provenance remain compatible via
    # the normalized persistent URL set.  Presentation metadata and covers are
    # intentionally excluded.
    urls = sorted({
        str(item.get("url") or "").strip()
        for item in list(media or [])
        if isinstance(item, dict) and item.get("url")
    })

    def media_key(values):
        canonical = json.dumps(sorted(values), ensure_ascii=False, separators=(",", ":"))
        return "media:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    primary = media_key(urls)
    aliases = {primary, *(media_key([item]) for item in urls)}
    return primary, sorted(aliases)


def _community_existing_post_id(conn, author_id, identity_keys, media):
    """Find new- or old-format rows for one already shared media work."""
    keys = sorted({str(item or "") for item in list(identity_keys or []) if str(item or "")})
    if keys:
        placeholders = ",".join("?" for _ in keys)
        row = conn.execute(
            "SELECT p.id FROM community_post_identities i "
            "JOIN community_posts p ON p.id=i.post_id "
            f"WHERE i.author_id=? AND i.identity_key IN ({placeholders}) "
            "AND p.status='published' ORDER BY p.created_at ASC LIMIT 1",
            (str(author_id or ""), *keys),
        ).fetchone()
        if row:
            return str(row[0] or "")
        row = conn.execute(
            f"SELECT id FROM community_posts WHERE author_id=? AND identity_key IN ({placeholders}) "
            "AND status='published' ORDER BY created_at ASC LIMIT 1",
            (str(author_id or ""), *keys),
        ).fetchone()
        if row:
            return str(row[0] or "")

    # Existing deployments stored a source-dependent identity.  Compare their
    # normalized media fingerprints in-process instead of rewriting production
    # rows during startup, so rollout remains an additive, reversible change.
    wanted_urls = {
        str(item.get("url") or "").strip()
        for item in list(media or [])
        if isinstance(item, dict) and item.get("url")
    }
    rows = conn.execute(
        "SELECT id,media_json FROM community_posts "
        "WHERE author_id=? AND status='published'",
        (str(author_id or ""),),
    ).fetchall()
    for post_id, raw_media in rows:
        try:
            stored = json.loads(raw_media or "[]")
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        stored_urls = {
            str(item.get("url") or "").strip()
            for item in stored
            if isinstance(item, dict) and item.get("url")
        } if isinstance(stored, list) else set()
        if wanted_urls & stored_urls:
            return str(post_id or "")
    return ""


def _community_clear_stale_identity_aliases(conn, author_id, identity_keys):
    """Release aliases left behind by an older soft-delete implementation.

    v136 removes aliases together with a post, but a forward rollback can run an
    older delete path that only changes ``community_posts.status``.  Such an
    alias must not keep its unique key forever and make a later re-share fail.
    Restrict cleanup to the keys used by this transaction so normal startup
    never rewrites unrelated community history.
    """
    keys = sorted({str(item or "") for item in list(identity_keys or []) if str(item or "")})
    if not keys:
        return
    placeholders = ",".join("?" for _ in keys)
    conn.execute(
        "DELETE FROM community_post_identities "
        f"WHERE author_id=? AND identity_key IN ({placeholders}) "
        "AND NOT EXISTS ("
        "SELECT 1 FROM community_posts p "
        "WHERE p.id=community_post_identities.post_id AND p.status='published'"
        ")",
        (str(author_id or ""), *keys),
    )


def _community_reaction_state(post_id, viewer_id=""):
    summary = _fetchone(
        "SELECT COALESCE(SUM(liked),0),COALESCE(SUM(favorited),0) "
        "FROM community_reactions WHERE post_id=?",
        (str(post_id or ""),),
    ) or (0, 0)
    viewer = (0, 0)
    if viewer_id:
        viewer = _fetchone(
            "SELECT liked,favorited FROM community_reactions WHERE post_id=? AND member_id=?",
            (str(post_id or ""), str(viewer_id or "")),
        ) or (0, 0)
    return {
        "likeCount": int(summary[0] or 0),
        "favoriteCount": int(summary[1] or 0),
        "viewerLiked": bool(viewer[0]),
        "viewerFavorited": bool(viewer[1]),
    }


def _community_post_public(row, viewer_id=""):
    if not row:
        return None
    try:
        media = json.loads(row[9])
    except (TypeError, ValueError, json.JSONDecodeError):
        media = []
    try:
        cover = json.loads(row[10] or "{}")
    except (TypeError, ValueError, json.JSONDecodeError):
        cover = {}
    team = None
    if row[3]:
        team_row = _fetchone(
            "SELECT id,name FROM teams WHERE id=? AND status='active'",
            (str(row[3]),),
        )
        if team_row:
            team = {"id": str(team_row[0]), "name": str(team_row[1] or "")}
    if not row[3]:
        # Compatibility for old posts that did not persist team_id.
        team = member_team(row[1])
    item = {
        "id": row[0],
        "authorId": row[1],
        "authorName": row[2],
        "teamId": row[3] or "",
        "sourceKind": row[4],
        "sourceId": row[5],
        "title": row[6],
        "copy": row[7] or "",
        "prompt": row[8] or "",
        "media": media if isinstance(media, list) else [],
        "cover": cover if isinstance(cover, dict) else {},
        "identityKey": row[11] or "",
        "category": row[12],
        "status": row[13],
        "createdAt": int(row[14] or 0),
        "updatedAt": int(row[15] or 0),
        "teamName": str((team or {}).get("name") or ""),
    }
    item.update(_community_reaction_state(item["id"], viewer_id))
    return item


def create_community_post(
    author_id,
    author_name,
    team_id,
    source_kind,
    source_id,
    title,
    copy_text,
    prompt_text,
    category,
    media,
    cover=None,
    source_identity=None,
):
    source_kind = str(source_kind or "").strip().lower()
    if source_kind not in COMMUNITY_SOURCE_KINDS:
        raise ValueError("invalid_community_source")
    category = str(category or "").strip()
    if category not in COMMUNITY_CATEGORIES:
        raise ValueError("invalid_community_category")
    title = re.sub(r"\s+", " ", str(title or "")).strip()[:120]
    if not title:
        raise ValueError("community_title_required")
    media = normalize_community_media(media)
    cover = normalize_community_cover(cover) if cover else {}
    identity_key, identity_keys = community_identity_keys(
        source_kind,
        source_id,
        media,
        cover,
        source_identity=source_identity,
    )
    now = int(time.time() * 1000)
    post_id = "community_" + uuid.uuid4().hex[:18]
    existing_id = ""
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            # Serialize the read-before-insert across separate server workers,
            # not only threads in this process.  This keeps two entry points
            # submitted at the same instant from both observing an empty row.
            conn.execute("BEGIN IMMEDIATE")
            _community_clear_stale_identity_aliases(
                conn, author_id, identity_keys,
            )
            existing_id = _community_existing_post_id(
                conn, author_id, identity_keys, media,
            )
            if existing_id:
                # A legacy URL-only row has no provenance aliases to bridge a
                # later materialized URL.  Bind only this request's primary
                # composite source key.  Do not bind every per-item gallery
                # alias: the old post may not actually display those items.
                if identity_key.startswith("source:"):
                    conn.execute(
                        "INSERT OR IGNORE INTO community_post_identities("
                        "author_id,identity_key,post_id,created_at"
                        ") VALUES(?,?,?,?)",
                        (str(author_id or ""), identity_key, existing_id, now),
                    )
                conn.commit()
            else:
                try:
                    conn.execute(
                        """
                        INSERT INTO community_posts(
                          id,author_id,author_name,team_id,source_kind,source_id,title,
                          copy_text,prompt_text,category,media_json,cover_json,identity_key,
                          status,created_at,updated_at
                        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                    (
                    post_id,
                    str(author_id or ""),
                    str(author_name or "")[:80],
                    str(team_id or "") or None,
                    source_kind,
                    str(source_id or "")[:160],
                    title,
                    str(copy_text or "")[:6000],
                    str(prompt_text or "")[:6000],
                    category,
                    json.dumps(media, ensure_ascii=False, separators=(",", ":")),
                    json.dumps(cover, ensure_ascii=False, separators=(",", ":")),
                    identity_key,
                    "published",
                    now,
                    now,
                    ),
                    )
                    conn.executemany(
                        "INSERT INTO community_post_identities(author_id,identity_key,post_id,created_at) "
                        "VALUES(?,?,?,?)",
                        [
                            (str(author_id or ""), key, post_id, now)
                            for key in identity_keys
                        ],
                    )
                    conn.commit()
                except sqlite3.IntegrityError:
                    # A second worker may have inserted the same media identity
                    # after our read.  Resolve to that post instead of surfacing
                    # a 500 or creating a duplicate on retry.
                    conn.rollback()
                    existing_id = _community_existing_post_id(
                        conn, author_id, identity_keys, media,
                    )
                    if not existing_id:
                        raise
        finally:
            conn.close()
    if existing_id:
        post = get_community_post(existing_id)
        if post:
            post["alreadyShared"] = True
        return post
    return get_community_post(post_id)


def get_community_post(post_id, include_non_published=False, viewer_id=""):
    _ensure_db()
    where = "id=?" if include_non_published else "id=? AND status='published'"
    row = _fetchone(
        f"""
        SELECT id,author_id,author_name,team_id,source_kind,source_id,title,
               copy_text,prompt_text,media_json,cover_json,identity_key,
               category,status,created_at,updated_at
        FROM community_posts WHERE {where}
        """,
        (str(post_id or ""),),
    )
    return _community_post_public(row, viewer_id)


def list_community_posts(category="", limit=40, before=0, viewer_id=""):
    _ensure_db()
    category = str(category or "").strip()
    limit = max(1, min(80, int(limit or 40)))
    before = max(0, int(before or 0))
    clauses = ["status='published'"]
    params = []
    if category:
        if category not in COMMUNITY_CATEGORIES:
            return {"items": [], "nextBefore": 0}
        clauses.append("category=?")
        params.append(category)
    if before:
        clauses.append("created_at<?")
        params.append(before)
    params.append(limit + 1)
    rows = _fetchall(
        f"""
        SELECT id,author_id,author_name,team_id,source_kind,source_id,title,
               copy_text,prompt_text,media_json,cover_json,identity_key,
               category,status,created_at,updated_at
        FROM community_posts
        WHERE {' AND '.join(clauses)}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        tuple(params),
    )
    has_more = len(rows) > limit
    items = [_community_post_public(row, viewer_id) for row in rows[:limit]]
    return {
        "items": items,
        "nextBefore": items[-1]["createdAt"] if has_more and items else 0,
    }


def community_post_status(
    author_id,
    source_kind,
    source_id,
    media,
    cover=None,
    source_identity=None,
):
    try:
        clean_media = normalize_community_media(media)
        clean_cover = normalize_community_cover(cover) if cover else {}
    except ValueError:
        return {"shared": False, "post": None}
    _identity_key, identity_keys = community_identity_keys(
        source_kind,
        source_id,
        clean_media,
        clean_cover,
        source_identity=source_identity,
    )
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            post_id = _community_existing_post_id(
                conn, author_id, identity_keys, clean_media,
            )
        finally:
            conn.close()
    post = get_community_post(post_id, viewer_id=author_id) if post_id else None
    return {"shared": bool(post), "post": post}


def set_community_reaction(post_id, member_id, liked=None, favorited=None):
    post = get_community_post(post_id)
    if not post:
        return None
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            row = conn.execute(
                "SELECT liked,favorited FROM community_reactions WHERE post_id=? AND member_id=?",
                (str(post_id), str(member_id)),
            ).fetchone() or (0, 0)
            next_liked = int(bool(liked)) if liked is not None else int(row[0] or 0)
            next_favorited = int(bool(favorited)) if favorited is not None else int(row[1] or 0)
            conn.execute(
                """
                INSERT INTO community_reactions(post_id,member_id,liked,favorited,updated_at)
                VALUES(?,?,?,?,?)
                ON CONFLICT(post_id,member_id) DO UPDATE SET
                  liked=excluded.liked,favorited=excluded.favorited,updated_at=excluded.updated_at
                """,
                (str(post_id), str(member_id), next_liked, next_favorited, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()
    return get_community_post(post_id, viewer_id=member_id)


def list_community_favorites(member_id, limit=80):
    limit = max(1, min(120, int(limit or 80)))
    rows = _fetchall(
        """
        SELECT p.id,p.author_id,p.author_name,p.team_id,p.source_kind,p.source_id,p.title,
               p.copy_text,p.prompt_text,p.media_json,p.cover_json,p.identity_key,
               p.category,p.status,p.created_at,p.updated_at
        FROM community_reactions r
        JOIN community_posts p ON p.id=r.post_id
        WHERE r.member_id=? AND r.favorited=1 AND p.status='published'
        ORDER BY r.updated_at DESC LIMIT ?
        """,
        (str(member_id or ""), limit),
    )
    return {"items": [_community_post_public(row, member_id) for row in rows]}


def delete_community_post(post_id):
    _ensure_db()
    with _lock:
        conn = _connect()
        try:
            cursor = conn.execute(
                "UPDATE community_posts SET status='deleted',updated_at=? WHERE id=? AND status='published'",
                (int(time.time() * 1000), str(post_id or "")),
            )
            if cursor.rowcount:
                conn.execute(
                    "DELETE FROM community_post_identities WHERE post_id=?",
                    (str(post_id or ""),),
                )
            conn.commit()
            return cursor.rowcount > 0
        finally:
            conn.close()
