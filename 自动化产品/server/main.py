# =========================================================
# ACG 视频工具 · 最小可运行后端（FastAPI）
# 作用：
#   1. 托管前端静态页（index.html + js/ ES Modules + styles/ 分仓 CSS）
#   2. /api/llm 转发 MiniMax M3 等模型请求（解决 CORS + 隐藏 Key）
#   3. /api/accounts /api/assets 等数据接口（JSON 文件存储，可换数据库）
#   4. 自动生成 OpenAPI 文档（/docs），CLI 与 agent 直接对接
# 运行：
#   pip install fastapi uvicorn httpx
#   export LLM_API_KEY=sk-xxx      # 不要把 Key 写进前端代码
#   uvicorn main:app --host 0.0.0.0 --port 8787
# =========================================================
import json
import os
import time
import uuid
import hashlib
import hmac
import base64
import asyncio
import socket
import ipaddress
import shutil
import subprocess
import tempfile
import mimetypes
import io
import re
import inspect
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

try:
    from PIL import Image, ImageOps, ImageEnhance
except Exception:  # Pillow is optional; image generation still works without post-normalization.
    Image = None
    ImageOps = None
    ImageEnhance = None

_HTTPX_ASYNC_CLIENT_PARAMS = set(inspect.signature(httpx.AsyncClient).parameters)
_HTTPX_ASYNC_CLIENT_GET_PARAMS = set(inspect.signature(httpx.AsyncClient.get).parameters)


def _httpx_async_client_kwargs(**kwargs):
    follow_redirects = bool(kwargs.pop("follow_redirects", False))
    if follow_redirects and "follow_redirects" in _HTTPX_ASYNC_CLIENT_PARAMS:
        kwargs["follow_redirects"] = True
    return kwargs


def _httpx_get_redirect_kwargs():
    if "follow_redirects" in _HTTPX_ASYNC_CLIENT_GET_PARAMS:
        return {"follow_redirects": True}
    if "allow_redirects" in _HTTPX_ASYNC_CLIENT_GET_PARAMS:
        return {"allow_redirects": True}
    return {}

try:
    from . import store
except ImportError:  # 兼容以脚本方式直接运行
    import store

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT.parent          # index.html 所在目录
DATA_FILE = Path(os.getenv("LEGACY_DATA_FILE", ROOT / "data.json"))
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", ROOT / "uploads"))
CUSTOM_CANVAS_DIR = FRONTEND_DIR / "vendor" / "infinite-canvas"


def load_env_local():
    for name in (".env.local", ".env"):
        path = FRONTEND_DIR / name
        if not path.exists():
            continue
        for line in path.read_text("utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            key, value = s.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_local()

VIDEO_WORKSHOP_ROOT = Path(
    os.getenv("VIDEO_WORKSHOP_ROOT", FRONTEND_DIR / "apps" / "video-workshop")
).expanduser().resolve()
VIDEO_WORKSHOP_WEB_DIR = Path(
    os.getenv("VIDEO_WORKSHOP_WEB_DIR", VIDEO_WORKSHOP_ROOT / "web")
).expanduser().resolve()
VIDEO_WORKSHOP_OUTPUT_DIR = Path(
    os.getenv("VIDEO_WORKSHOP_OUTPUT_DIR", VIDEO_WORKSHOP_ROOT / "outputs")
).expanduser().resolve()
VIDEO_WORKSHOP_UPLOAD_DIR = Path(
    os.getenv("VIDEO_WORKSHOP_UPLOAD_DIR", VIDEO_WORKSHOP_ROOT / "uploads")
).expanduser().resolve()
VIDEO_WORKSHOP_URL = os.getenv("VIDEO_WORKSHOP_URL", "http://127.0.0.1:8765").rstrip("/")
VIDEO_WORKSHOP_TIMEOUT = float(os.getenv("VIDEO_WORKSHOP_TIMEOUT", "180") or "180")
VIDEO_WORKSHOP_SESSION_COOKIE = "acg_custom_video_session"
CUSTOM_CANVAS_SESSION_COOKIE = "acg_custom_canvas_session"
CUSTOM_CANVAS_SESSION_TTL = 30 * 60


def _positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default)) or default))
    except (TypeError, ValueError):
        return default


# 上游达到并发上限时请求先在本服务排队，避免直接把 429/任务上限暴露给创作者。
IMAGE_SUBMIT_QUEUE = asyncio.Semaphore(_positive_env_int("IMAGE_SUBMIT_CONCURRENCY", 3))
VIDEO_SUBMIT_QUEUE = asyncio.Semaphore(_positive_env_int("VIDEO_SUBMIT_CONCURRENCY", 10))
# Keep data-URL reference images comfortably below the upstream 10 MB request cap.
# These are encoded-data budgets because JSON payloads carry base64 strings, not raw files.
IMAGE_REFERENCE_TOTAL_DATA_URL_BYTES = _positive_env_int("IMAGE_REFERENCE_TOTAL_DATA_URL_BYTES", 7_200_000)
IMAGE_REFERENCE_MAX_DATA_URL_BYTES = _positive_env_int("IMAGE_REFERENCE_MAX_DATA_URL_BYTES", 2_400_000)

LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", (LLM_BASE_URL + "/v1/chat/completions") if LLM_BASE_URL else "https://api.minimaxi.com/v1/chat/completions")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "MiniMax-M3")
LLM_FORCE_MODEL = os.getenv("LLM_FORCE_MODEL", "true").lower() not in {"0", "false", "no"}
LLM_THINKING = os.getenv("LLM_THINKING", "").strip().lower()
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "0") or "0")
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "120"))
LLM_CONNECT_TIMEOUT = float(os.getenv("LLM_CONNECT_TIMEOUT", "12"))
LLM_SUPPORTS_RESPONSE_FORMAT = os.getenv("LLM_SUPPORTS_RESPONSE_FORMAT", "").strip().lower()
LLM_VISION_MODEL = os.getenv("LLM_VISION_MODEL", "").strip()
VIDEO_PROVIDER = (os.getenv("VIDEO_PROVIDER") or os.getenv("SEEDANCE_PROVIDER") or "seedance").strip().lower()
SEEDANCE_API_KEY = (
    os.getenv("SEEDANCE_API_KEY", "")
    or os.getenv("JIMENG_API_KEY", "")
    or os.getenv("ARK_API_KEY", "")
    or os.getenv("VIDEO_API_KEY", "")
    or os.getenv("SEEDANCE_KEY", "")
)
_ARK_VIDEO_KEY = SEEDANCE_API_KEY.strip().startswith("ark-")
_DEFAULT_SEEDANCE_BASE_URL = "https://ark.cn-beijing.volces.com" if _ARK_VIDEO_KEY else "https://api.llmone.ai"
_EXPLICIT_SEEDANCE_BASE_URL = os.getenv("SEEDANCE_BASE_URL") or os.getenv("JIMENG_BASE_URL") or os.getenv("ARK_BASE_URL")
SEEDANCE_BASE_URL = (_EXPLICIT_SEEDANCE_BASE_URL or ("" if _ARK_VIDEO_KEY else os.getenv("LLMONE_BASE_URL", "")) or _DEFAULT_SEEDANCE_BASE_URL).rstrip("/")
SEEDANCE_MODEL = os.getenv("SEEDANCE_MODEL") or os.getenv("JIMENG_MODEL") or os.getenv("ARK_VIDEO_MODEL") or "doubao-seedance-2-0-260128"
DIGITAL_HUMAN_MODEL = os.getenv("DIGITAL_HUMAN_MODEL") or os.getenv("OMNIHUMAN_MODEL") or os.getenv("OMINIHUMAN_MODEL") or "omni-human-1.5"
SEEDANCE_RESOLUTION = os.getenv("SEEDANCE_RESOLUTION", "720p")
SEEDANCE_GENERATE_AUDIO = os.getenv("SEEDANCE_GENERATE_AUDIO", "").lower() in {"1", "true", "yes"}
SEEDANCE_WATERMARK = os.getenv("SEEDANCE_WATERMARK", "").lower() in {"1", "true", "yes"}
SEEDANCE_SUBMIT_PATH = os.getenv("SEEDANCE_SUBMIT_PATH", "").strip()
SEEDANCE_POLL_PATH = os.getenv("SEEDANCE_POLL_PATH", "").strip()
SEEDANCE_PAYLOAD_MODE = os.getenv("SEEDANCE_PAYLOAD_MODE", "").strip().lower()
DIGITAL_HUMAN_ACCESS_KEY = (
    os.getenv("DIGITAL_HUMAN_ACCESS_KEY", "")
    or os.getenv("VOLC_ACCESS_KEY_ID", "")
    or os.getenv("VOLCENGINE_ACCESS_KEY_ID", "")
    or os.getenv("VOLC_ACCESSKEY", "")
    or os.getenv("VOLC_AK", "")
)
DIGITAL_HUMAN_SECRET_KEY = (
    os.getenv("DIGITAL_HUMAN_SECRET_KEY", "")
    or os.getenv("VOLC_SECRET_ACCESS_KEY", "")
    or os.getenv("VOLCENGINE_SECRET_ACCESS_KEY", "")
    or os.getenv("VOLC_SECRETKEY", "")
    or os.getenv("VOLC_SK", "")
)
DIGITAL_HUMAN_SECURITY_TOKEN = os.getenv("DIGITAL_HUMAN_SECURITY_TOKEN", "") or os.getenv("VOLC_SECURITY_TOKEN", "")
DIGITAL_HUMAN_BASE_URL = os.getenv("DIGITAL_HUMAN_BASE_URL", "https://visual.volcengineapi.com").rstrip("/")
DIGITAL_HUMAN_REQ_KEY = os.getenv("DIGITAL_HUMAN_REQ_KEY", "jimeng_realman_avatar_picture_omni_v15")
DIGITAL_HUMAN_REGION = os.getenv("DIGITAL_HUMAN_REGION", "cn-north-1")
DIGITAL_HUMAN_SERVICE = os.getenv("DIGITAL_HUMAN_SERVICE", "cv")
DIGITAL_HUMAN_OUTPUT_RESOLUTION = int(os.getenv("DIGITAL_HUMAN_OUTPUT_RESOLUTION", "720") or "720")
DIGITAL_HUMAN_PE_FAST_MODE = os.getenv("DIGITAL_HUMAN_PE_FAST_MODE", "true").lower() not in {"0", "false", "no"}
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
VIDEO_REFS = {}
COMPOSED_DIR = Path(os.getenv("COMPOSED_DIR", ROOT / "composed"))
VIDEO_OUTPUT_CACHE_MAX_BYTES = int(os.getenv("VIDEO_OUTPUT_CACHE_MAX_BYTES", "734003200") or "734003200")
MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY", "")
MINIMAX_BASE_URL = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com").rstrip("/")
MINIMAX_GROUP_ID = os.getenv("MINIMAX_GROUP_ID", "").strip()
MINIMAX_TTS_MODEL = os.getenv("MINIMAX_TTS_MODEL", "speech-2.8-hd")
MINIMAX_VOICE_ID = os.getenv("MINIMAX_VOICE_ID", "presenter_female")
MINIMAX_TTS_SPEED = float(os.getenv("MINIMAX_TTS_SPEED", "1.2") or "1.2")
DEFAULT_MINIMAX_VOICE_PRESETS = [
    {"name": "男声 · 青涩青年男生，清爽少年感", "voiceId": "male-qn-qingse"},
    {"name": "男声 · 精英青年男声，商务稳重", "voiceId": "male-qn-jingying"},
    {"name": "男声 · 霸道总裁，低沉磁性", "voiceId": "male-qn-badao"},
    {"name": "男声 · 大学生男生，日常自然", "voiceId": "male-qn-daxuesheng"},
    {"name": "男声 · 男新闻主持人，标准播音腔", "voiceId": "presenter_male"},
    {"name": "男声 · 温和有声书男声 1", "voiceId": "audiobook_male_1"},
    {"name": "男声 · 厚重故事说书男声 2", "voiceId": "audiobook_male_2"},
    {"name": "男声 · 机灵小男孩音色", "voiceId": "clever_boy"},
    {"name": "男声 · 可爱小男孩", "voiceId": "cute_boy"},
    {"name": "女声 · 元气清甜少女", "voiceId": "female-shaonv"},
    {"name": "女声 · 冷艳御姐", "voiceId": "female-yujie"},
    {"name": "女声 · 成熟知性中年女声", "voiceId": "female-chengshu"},
    {"name": "女声 · 软萌甜妹", "voiceId": "female-tianmei"},
    {"name": "女声 · 女新闻主播，标准播音", "voiceId": "presenter_female"},
    {"name": "女声 · 温柔有声书女声 1", "voiceId": "audiobook_female_1"},
    {"name": "女声 · 细腻叙事女声 2", "voiceId": "audiobook_female_2"},
    {"name": "女声 · 可爱小女孩", "voiceId": "lovely_girl"},
    {"name": "卡通特色 · 卡通小七童趣音色", "voiceId": "cartoon_xiaoqi"},
]
_ENV_MINIMAX_VOICE_PRESETS = [
    {"name": item.split(":", 1)[0].strip(), "voiceId": item.split(":", 1)[1].strip()}
    for item in os.getenv("MINIMAX_VOICE_PRESETS", "").split(",")
    if ":" in item and item.split(":", 1)[0].strip() and item.split(":", 1)[1].strip()
]


def _load_minimax_system_voice_presets() -> List[Dict[str, str]]:
    path = ROOT / "minimax_system_voices.json"
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text("utf-8"))
    except Exception:
        return []
    rows = []
    for item in raw if isinstance(raw, list) else []:
        voice_id = str(item.get("voiceId") or "").strip()
        name = str(item.get("name") or voice_id).strip()
        if voice_id and name:
            rows.append({"name": name, "voiceId": voice_id})
    return rows


def _merge_voice_presets(*groups: List[Dict[str, str]]) -> List[Dict[str, str]]:
    merged: List[Dict[str, str]] = []
    seen = set()
    for group in groups:
        for item in group or []:
            voice_id = str(item.get("voiceId") or "").strip()
            name = str(item.get("name") or voice_id).strip()
            if not voice_id or voice_id in seen:
                continue
            seen.add(voice_id)
            merged.append({"name": name, "voiceId": voice_id})
    return merged


MINIMAX_SYSTEM_VOICE_PRESETS = _load_minimax_system_voice_presets()
MINIMAX_VOICE_PRESETS = _merge_voice_presets(_ENV_MINIMAX_VOICE_PRESETS, DEFAULT_MINIMAX_VOICE_PRESETS, MINIMAX_SYSTEM_VOICE_PRESETS)
IMAGE_API_KEY = os.getenv("IMAGE_API_KEY", "") or LLM_API_KEY
IMAGE_BASE_URL = os.getenv("IMAGE_BASE_URL", "https://tokenhub.tencentmaas.com/v1").rstrip("/")
IMAGE_ENDPOINT = os.getenv("IMAGE_ENDPOINT", "").strip()
IMAGE_MODEL = os.getenv("IMAGE_MODEL", "custom-imagemodel-gt")
IMAGE_MODE = os.getenv("IMAGE_MODE", "").strip().lower()
IMAGE_CLIENT_ENDPOINT_ALLOWLIST = os.getenv(
    "IMAGE_CLIENT_ENDPOINT_ALLOWLIST",
    "",
).strip()
PROXY_FILE_MAX_BYTES = _positive_env_int(
    "PROXY_FILE_MAX_BYTES",
    256 * 1024 * 1024,
)
PROXY_FILE_TIMEOUT = float(os.getenv("PROXY_FILE_TIMEOUT", "180") or "180")
PROXY_FILE_MAX_REDIRECTS = _positive_env_int("PROXY_FILE_MAX_REDIRECTS", 5)
JUSTONE_API_KEY = (
    os.getenv("JUSTONE_API_KEY", "")
    or os.getenv("JUSTONE_API_TOKEN", "")
    or os.getenv("JUSTONE_TOKEN", "")
    or os.getenv("JUSTONEAPI_KEY", "")
    or os.getenv("JUSTONEAPI_TOKEN", "")
)
JUSTONE_BASE_URL = (os.getenv("JUSTONE_BASE_URL", "") or os.getenv("JUSTONEAPI_BASE_URL", "") or "https://api.justoneapi.com").rstrip("/")
JUSTONE_SHARE_PATH = os.getenv("JUSTONE_SHARE_PATH", "/api/xiaohongshu/share-url-transfer/v1")
JUSTONE_NOTE_DETAIL_PATH = os.getenv("JUSTONE_NOTE_DETAIL_PATH", "/api/xiaohongshu/get-note-detail/v2")
JUSTONE_WECHAT_BASIC_PATH = os.getenv("JUSTONE_WECHAT_BASIC_PATH", "/api/weixin-channels/get-video-basic-info/v1")
JUSTONE_WECHAT_METRICS_PATH = os.getenv("JUSTONE_WECHAT_METRICS_PATH", "/api/weixin-channels/get-video-metrics/v1")
JUSTONE_TIMEOUT = float(os.getenv("JUSTONE_TIMEOUT", "90") or "90")

app = FastAPI(title="ACG 视频工具 API", version="0.1.0",
              description="账号化 AI 视频生产工作台后端。CLI / agent 可直接按本 OpenAPI 调用。")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
}

IMMUTABLE_STATIC_MAX_AGE = 31536000
IMMUTABLE_STATIC_EXTENSIONS = {
    ".css",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".mjs",
    ".otf",
    ".png",
    ".svg",
    ".ttf",
    ".wasm",
    ".webp",
    ".woff",
    ".woff2",
}
HASHED_STATIC_NAME_RE = re.compile(
    r"(?:^|[-._/])[0-9a-f]{8,}(?=[-._/]|$)",
    re.IGNORECASE,
)


def _static_cache_headers(path: Any, query_string: Any = b"") -> dict[str, str]:
    """Cache only URLs whose identity changes when their bytes change.

    HTML and unversioned assets deliberately remain revalidated on every visit.
    The main frontend appends a release-specific ``?v=`` token to its JS/CSS
    imports, while the vendored Next build uses content/build hashes in
    ``_next/static``. Those URL families are safe to keep for a year.
    """
    normalized = str(path or "").replace("\\", "/").lstrip("/")
    suffix = Path(normalized).suffix.lower()
    if suffix not in IMMUTABLE_STATIC_EXTENSIONS:
        return dict(NO_CACHE_HEADERS)

    raw_query = (
        query_string.decode("utf-8", errors="ignore")
        if isinstance(query_string, (bytes, bytearray))
        else str(query_string or "")
    )
    query = parse_qs(raw_query, keep_blank_values=True)
    has_release_version = any(str(value).strip() for value in query.get("v", []))
    is_next_static = normalized.startswith("_next/static/")
    is_content_hashed = bool(HASHED_STATIC_NAME_RE.search(normalized))
    if has_release_version or is_next_static or is_content_hashed:
        return {
            "Cache-Control": f"public, max-age={IMMUTABLE_STATIC_MAX_AGE}, immutable",
        }
    return dict(NO_CACHE_HEADERS)


class VersionAwareStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        cache_headers = (
            _static_cache_headers(path, scope.get("query_string", b""))
            if response.status_code in {200, 206, 304}
            else dict(NO_CACHE_HEADERS)
        )
        for name in ("Cache-Control", "Pragma"):
            if name not in cache_headers and name in response.headers:
                del response.headers[name]
        response.headers.update(cache_headers)
        return response


def no_cache_file(path: Path, media_type: str = None):
    return FileResponse(str(path), media_type=media_type, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache"
    })


def version_aware_static_file(path: Path, request: Request, media_type: str = None):
    return FileResponse(
        str(path),
        media_type=media_type,
        headers=_static_cache_headers(path.name, request.scope.get("query_string", b"")),
    )


def ranged_file_response(request: Request, path: Path, media_type: str = None, cache_seconds: int = 3600):
    size = path.stat().st_size
    media = media_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    base_headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": f"public, max-age={cache_seconds}",
    }
    range_header = request.headers.get("range") or request.headers.get("Range")
    if not range_header:
        return FileResponse(str(path), media_type=media, headers=base_headers)

    m = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
    if not m:
        return FileResponse(str(path), media_type=media, headers=base_headers)

    start_raw, end_raw = m.groups()
    if start_raw == "" and end_raw == "":
        return FileResponse(str(path), media_type=media, headers=base_headers)
    if start_raw == "":
        suffix = int(end_raw or "0")
        start = max(size - suffix, 0)
        end = size - 1
    else:
        start = int(start_raw)
        end = int(end_raw) if end_raw else size - 1
    end = min(end, size - 1)
    if start >= size or start > end:
        return Response(status_code=416, headers={**base_headers, "Content-Range": f"bytes */{size}"})

    length = end - start + 1

    def chunked():
        with path.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                data = f.read(min(1024 * 1024, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        **base_headers,
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Content-Length": str(length),
    }
    return StreamingResponse(chunked(), status_code=206, media_type=media, headers=headers)


# ---------- 简易 JSON 存储（团队规模够用，后续可换 SQLite/Postgres） ----------
def load_db() -> dict:
    if DATA_FILE.exists():
        return json.loads(DATA_FILE.read_text("utf-8"))
    return {"accounts": [], "assets": [], "tasks": []}


def save_db(db: dict):
    DATA_FILE.write_text(json.dumps(db, ensure_ascii=False, indent=2), "utf-8")


# ---------- 模型代理 ----------
def _mask_endpoint(url: str) -> str:
    if not url:
        return ""
    try:
        parts = url.split("/")
        if len(parts) >= 3:
            return parts[0] + "//" + parts[2] + "/" + "/".join(parts[3:]).split("?")[0]
    except Exception:
        pass
    return url.split("?")[0]


def _llm_headers(auth: str = ""):
    token = (auth or "").replace("Bearer ", "").strip() or LLM_API_KEY
    if not token:
        return {"Content-Type": "application/json"}
    return {"Content-Type": "application/json", "Authorization": "Bearer " + token}


def _llm_error(status_code: int, detail: str, raw: str = ""):
    msg = str(detail or raw or "语言模型调用失败")
    low = msg.lower()
    if status_code == 401:
        msg = "语言模型 token 无效或不属于当前 endpoint。请确认 LLM_ENDPOINT/LLM_BASE_URL 与 LLM_API_KEY 是同一网关签发。"
    elif "model_not_found" in low or "model not found" in low or "not found model" in low:
        msg = "语言模型网关可达，但模型名不可用。请把 LLM_MODEL 改成该网关 /v1/models 返回的可用 chat 模型。"
    elif "connect call failed" in low or "timed out" in low or "connecterror" in low:
        msg = "服务器无法连接语言模型 endpoint：" + _mask_endpoint(LLM_ENDPOINT) + "。请改用 BCC 可访问的内网网关，或配置可用代理。"
    return HTTPException(status_code, msg[:800])


def _llm_is_minimax() -> bool:
    value = f"{LLM_ENDPOINT} {LLM_MODEL}".lower()
    return "minimax" in value


def _llm_supports_response_format() -> bool:
    if LLM_SUPPORTS_RESPONSE_FORMAT in {"1", "true", "yes"}:
        return True
    if LLM_SUPPORTS_RESPONSE_FORMAT in {"0", "false", "no"}:
        return False
    return not _llm_is_minimax()


def _clean_llm_text(text: str = "") -> str:
    out = str(text or "")
    out = re.sub(r"<think>.*?</think>", "", out, flags=re.I | re.S)
    out = re.sub(r"^\s*思考[:：].*?(?=\n\s*(?:答复|回答|输出|正文)[:：]|\Z)", "", out, flags=re.S)
    out = re.sub(r"^\s*(?:答复|回答|输出|正文)[:：]\s*", "", out)
    return out.strip()


async def _call_llm(body: dict, auth_header: str = "", force_deployed_model: bool = True):
    if force_deployed_model and LLM_FORCE_MODEL and LLM_MODEL:
        body["model"] = LLM_MODEL
    if not _llm_supports_response_format():
        body.pop("response_format", None)
    thinking = LLM_THINKING
    if thinking == "enabled" and _llm_is_minimax():
        thinking = "adaptive"
    # The browser must not be able to override the deployed provider policy.
    # This also protects active tabs that still have a cached older bundle.
    if thinking in {"adaptive", "enabled", "disabled"}:
        body["thinking"] = {"type": thinking}
    elif _llm_is_minimax():
        body.pop("thinking", None)
    if LLM_MAX_TOKENS > 0:
        body["max_tokens"] = LLM_MAX_TOKENS
    elif _llm_is_minimax() and int(body.get("max_tokens") or 0) > 4096:
        body["max_tokens"] = 4096
    transient_statuses = {408, 425, 429, 500, 502, 503, 504}
    last_error = None
    async with httpx.AsyncClient(timeout=httpx.Timeout(LLM_TIMEOUT, connect=LLM_CONNECT_TIMEOUT), trust_env=False) as client:
        for attempt in range(2):
            try:
                response = await client.post(LLM_ENDPOINT, json=body, headers=_llm_headers(auth_header))
            except httpx.RequestError as exc:
                last_error = exc
                if attempt == 0:
                    await asyncio.sleep(0.35)
                    continue
                raise _llm_error(502, f"{exc.__class__.__name__}: {exc}")
            response_detail = response.text[:800].lower()
            permanent_limit = any(marker in response_detail for marker in (
                "余额", "额度", "insufficient", "quota", "credit",
            ))
            if response.status_code in transient_statuses and not permanent_limit and attempt == 0:
                retry_after = response.headers.get("retry-after", "")
                try:
                    delay_seconds = min(1.6, max(0.1, float(retry_after)))
                except (TypeError, ValueError):
                    delay_seconds = 0.35
                await asyncio.sleep(delay_seconds)
                continue
            return response
    raise _llm_error(502, f"{last_error.__class__.__name__}: {last_error}" if last_error else "语言模型调用失败")


class LLMReq(BaseModel):
    messages: list
    json_mode: bool = False
    temperature: float = 0.7


class VisionCopyReq(BaseModel):
    imageDataUrl: str
    accountStyle: str = ""


class AnalyticsJustOneReq(BaseModel):
    url: str
    platform: str = ""
    noteId: str = ""
    objectId: str = ""
    objectNonceId: str = ""


class ImageRef(BaseModel):
    role: str = "shared"
    name: str = ""
    mime: str = ""
    url: str = ""
    dataUrl: str = ""


class ImageGenerateReq(BaseModel):
    prompt: str
    refs: List[ImageRef] = []
    ratio: str = "3:4"
    strictRatio: bool = False
    endpoint: str = ""
    model: str = ""
    apiKey: str = ""


def _member_from_authorization(authorization: str = ""):
    token = str(authorization or "").replace("Bearer ", "").strip()
    member_id = store.parse_token(token) if token else None
    row = store.get_member(member_id) if member_id else None
    if not row:
        raise HTTPException(401, "未登录或登录已过期")
    return store.member_public(row)


def require_creator(authorization: str = Header(default="")):
    """高成本创作能力只允许已登录的管理员或创作成员调用。"""
    member = _member_from_authorization(authorization)
    if member["role"] not in {"admin", "editor"}:
        raise HTTPException(403, "当前账号不能使用创作能力")
    return member


def _clean_image_endpoint(endpoint: str = "") -> str:
    endpoint = (endpoint or "").strip()
    if not endpoint:
        return ""
    if endpoint.startswith("/api/image") or endpoint.startswith("/api/"):
        return ""
    return endpoint


def _endpoint_hostname(value: str = "") -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw if "://" in raw else "//" + raw)
    return (parsed.hostname or "").strip().lower().rstrip(".")


def _endpoint_origin(value: str = "") -> Optional[Tuple[str, str, int]]:
    raw = str(value or "").strip()
    if not raw:
        return None
    parsed = urlparse(raw if "://" in raw else "https://" + raw)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if scheme not in {"http", "https"} or not host:
        return None
    try:
        port = parsed.port or (443 if scheme == "https" else 80)
    except ValueError:
        return None
    return scheme, host, port


def _allowed_client_image_origins() -> set:
    origins = {("https", "tokenhub.tencentmaas.com", 443)}
    for value in (IMAGE_ENDPOINT, IMAGE_BASE_URL):
        origin = _endpoint_origin(value)
        if origin:
            origins.add(origin)
    for value in IMAGE_CLIENT_ENDPOINT_ALLOWLIST.split(","):
        origin = _endpoint_origin(value)
        if origin:
            origins.add(origin)
    return origins


def _validated_client_image_endpoint(endpoint: str = "") -> str:
    cleaned = _clean_image_endpoint(endpoint)
    if not cleaned:
        return ""
    parsed = urlparse(cleaned)
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username
        or parsed.password
    ):
        raise HTTPException(400, "图片服务地址格式不安全")
    origin = _endpoint_origin(cleaned)
    if not origin or origin not in _allowed_client_image_origins():
        raise HTTPException(403, "图片服务地址不在服务器白名单")
    return cleaned


def _image_endpoint(endpoint: str = "") -> str:
    def _normalize_known_image_endpoint(raw: str) -> str:
        base = (raw or "").strip().rstrip("/")
        if not base:
            return ""
        is_maas = _image_is_maas_mode(model=IMAGE_MODEL, endpoint=base)
        if is_maas:
            if base.endswith("/v1/images/generations"):
                return base[:-len("/images/generations")] + "/aiart/gtimage"
            if base.endswith("/images/generations"):
                return base[:-len("/images/generations")] + "/aiart/gtimage"
            if base.endswith("/v1"):
                return base + "/aiart/gtimage"
            if base.endswith("/aiart/gtimage"):
                return base
            if "/v1/" not in base:
                return base + "/v1/aiart/gtimage"
        return base

    endpoint = _clean_image_endpoint(endpoint)
    if endpoint:
        base = _normalize_known_image_endpoint(endpoint)
        if (
            base.endswith("/responses")
            or base.endswith("/chat/completions")
            or base.endswith("/images/generations")
            or base.endswith("/aiart/gtimage")
        ):
            return base
        if _image_is_maas_mode(model=IMAGE_MODEL, endpoint=base):
            return base + "/aiart/gtimage" if base.endswith("/v1") else base + "/v1/aiart/gtimage"
        return base + "/v1/images/generations"
    if IMAGE_ENDPOINT:
        return _normalize_known_image_endpoint(IMAGE_ENDPOINT)
    base = _normalize_known_image_endpoint(IMAGE_BASE_URL or "https://tokenhub.tencentmaas.com/v1")
    if (
        base.endswith("/responses")
        or base.endswith("/chat/completions")
        or base.endswith("/images/generations")
        or base.endswith("/aiart/gtimage")
    ):
        return base
    if _image_is_responses_mode(model=IMAGE_MODEL, endpoint=base):
        return base.rstrip("/") + "/responses" if base.endswith("/v1") else base.rstrip("/") + "/v1/responses"
    if _image_is_chat_mode(model=IMAGE_MODEL, endpoint=base):
        return base.rstrip("/") + "/chat/completions" if base.endswith("/v1") else base.rstrip("/") + "/v1/chat/completions"
    if _image_is_maas_mode(model=IMAGE_MODEL, endpoint=base):
        return base.rstrip("/") + "/aiart/gtimage" if base.endswith("/v1") else base.rstrip("/") + "/v1/aiart/gtimage"
    if base.endswith("/images/generations"):
        return base
    return base + "/v1/images/generations"


def _maas_base_from_endpoint(endpoint: str = "") -> str:
    base = (endpoint or IMAGE_ENDPOINT or IMAGE_BASE_URL or "https://tokenhub.tencentmaas.com/v1").strip().rstrip("/")
    for suffix in (
        "/v1/aiart/gtimage",
        "/v1/aiart/gttext",
        "/v1/images/generations",
        "/v1/images/edits",
        "/aiart/gtimage",
        "/aiart/gttext",
        "/images/generations",
        "/images/edits",
        "/responses",
        "/chat/completions",
    ):
        if base.endswith(suffix):
            base = base[:-len(suffix)]
            break
    if not base.endswith("/v1"):
        base = base.rstrip("/") + "/v1"
    return base


def _maas_endpoint_for_refs(endpoint: str = "", has_refs: bool = False) -> str:
    suffix = "/aiart/gtimage" if has_refs else "/aiart/gttext"
    return _maas_base_from_endpoint(endpoint) + suffix


def _image_edit_endpoint(endpoint: str = "") -> str:
    gen = _image_endpoint(endpoint)
    if _image_is_maas_mode(endpoint=gen):
        return _maas_base_from_endpoint(gen) + "/aiart/gtimage"
    if gen.endswith("/images/generations"):
        return gen[:-len("/generations")] + "/edits"
    return gen.rstrip("/") + "/edits"


def _image_model_for_request(requested: str, endpoint: str) -> str:
    """Keep old browser caches from forcing the wrong image adapter/model."""
    model = (requested or "").strip()
    if _image_is_maas_mode(endpoint=endpoint):
        stale_aliases = {
            "custom-textmodel-gt",
            "gpt-image-2",
            "gpt-image-1",
            "dall-e-3",
            "dall-e-2",
            "image-2",
        }
        if not model or model.lower() in stale_aliases:
            return IMAGE_MODEL or "custom-imagemodel-gt"
    return model or IMAGE_MODEL


def _image_request_config(req: ImageGenerateReq) -> Tuple[str, str, str]:
    """服务器托管时完全忽略浏览器 Key/endpoint，避免平台 Key 被转发到外部地址。"""
    if IMAGE_API_KEY:
        endpoint = _image_endpoint()
        return IMAGE_API_KEY, endpoint, _image_edit_endpoint()
    api_key = str(req.apiKey or "").strip()
    if not api_key:
        raise HTTPException(500, "服务器未配置图片 API Key")
    client_endpoint = _validated_client_image_endpoint(req.endpoint)
    endpoint = _image_endpoint(client_endpoint)
    return api_key, endpoint, _image_edit_endpoint(client_endpoint)


def _maas_model_for_refs(requested: str, has_refs: bool) -> str:
    model = (requested or IMAGE_MODEL or "").strip()
    stale_aliases = {
        "",
        "custom-textmodel-gt",
        "gpt-image-2",
        "gpt-image-1",
        "image-2",
        "dall-e-3",
        "dall-e-2",
    }
    if model.lower() in stale_aliases:
        return "custom-imagemodel-gt"
    return model


def _image_size(ratio: str) -> str:
    # TokenHub Image2 rejects 1080-based canvases. Use native legal sizes with
    # the same aspect ratio so the model renders the requested canvas directly.
    if ratio == "3:4":
        return "1152x1536"
    if ratio == "9:16":
        return "1152x2048"
    if ratio == "1:1":
        return "1024x1024"
    if ratio == "16:9":
        return "2048x1152"
    if ratio == "4:3":
        return "1536x1152"
    return "1152x1536"


def _normalize_image_ratio(ratio: str) -> str:
    value = (ratio or "3:4").strip()
    return value if value in ("3:4", "9:16", "1:1", "16:9", "4:3") else "3:4"


def _infer_image_ratio_from_prompt(prompt: str, fallback: str) -> str:
    text = prompt or ""
    if re.search(r"9\s*[:：]\s*16|1080\s*[x×]\s*1920|竖屏\s*9\s*[:：]\s*16", text):
        return "9:16"
    if re.search(r"16\s*[:：]\s*9|1920\s*[x×]\s*1080|横屏\s*16\s*[:：]\s*9", text):
        return "16:9"
    if re.search(r"4\s*[:：]\s*3|1440\s*[x×]\s*1080", text):
        return "4:3"
    if re.search(r"1\s*[:：]\s*1|1024\s*[x×]\s*1024|1080\s*[x×]\s*1080|正方形(?:画布|尺寸|图片|配图)|方形(?:画布|图片|配图)", text):
        return "1:1"
    if re.search(r"3\s*[:：]\s*4|1080\s*[x×]\s*1440|小红书竖版|小红书笔记", text):
        return "3:4"
    return fallback


def _image_target_size(ratio: str) -> Tuple[int, int]:
    if ratio == "1:1":
        return 1080, 1080
    if ratio == "9:16":
        return 1080, 1920
    return 1080, 1440


IMAGE_PROMPT_TEXT_REPLACEMENTS = (
    ("图片由 AI 生成", "图片由系统生成"),
    ("图片由AI生成", "图片由系统生成"),
    ("由 AI 生成", "由系统生成"),
    ("由AI生成", "由系统生成"),
    ("AI 生成", "智能生成"),
    ("AI生成", "智能生成"),
    ("清爽种草感", "清爽真实分享感"),
    ("种草感", "真实分享感"),
    ("轻种草", "轻推荐"),
    ("首图", "大字标题"),
)


IMAGE_PROMPT_GUARD = (
    "负面约束：不出现页码，不出现二维码，图片右上角和左上角不要加入logo，其他位置可以正常出现logo。"
)


def _guard_image_prompt(prompt: str) -> str:
    """Keep provider marks and internal planning labels out of generated images."""
    text = prompt or ""
    for src, dst in IMAGE_PROMPT_TEXT_REPLACEMENTS:
        text = text.replace(src, dst)
    text = re.sub(r"负面约束\s*[:：][\s\S]*$", "", text).rstrip()
    return f"{text}\n\n{IMAGE_PROMPT_GUARD}".strip()


def _image_is_chat_mode(model: str = "", endpoint: str = "") -> bool:
    value = " ".join([IMAGE_MODE, model or IMAGE_MODEL, endpoint or IMAGE_ENDPOINT or IMAGE_BASE_URL]).lower()
    return "chat" in value or value.rstrip("/").endswith("/chat/completions")


def _image_is_responses_mode(model: str = "", endpoint: str = "") -> bool:
    value = " ".join([IMAGE_MODE, model or IMAGE_MODEL, endpoint or IMAGE_ENDPOINT or IMAGE_BASE_URL]).lower()
    return "response" in value or value.rstrip("/").endswith("/responses")


def _image_is_maas_mode(model: str = "", endpoint: str = "") -> bool:
    value = " ".join([IMAGE_MODE, model or IMAGE_MODEL, endpoint or IMAGE_ENDPOINT or IMAGE_BASE_URL]).lower()
    return (
        "maas" in value
        or "aiart" in value
        or "custom-imagemodel" in value
        or "tokenhub.tencentmaas.com" in value
    )


def _image_from_response(data: dict, default_mime: str = "image/png") -> str:
    item = ((data.get("data") or [{}])[0] if isinstance(data.get("data"), list) else {}) or \
        ((data.get("images") or [{}])[0] if isinstance(data.get("images"), list) else {}) or \
        _deep_get(data, ("result", "data", 0), default={}) or {}
    b64 = item.get("b64_json") or item.get("b64") or item.get("base64") or data.get("b64_json")
    if b64:
        return b64 if str(b64).startswith("data:image/") else "data:%s;base64,%s" % (default_mime, str(b64))
    return item.get("url") or data.get("url") or ""


def _find_image_url_or_data(value) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        s = value.strip()
        if s.startswith("data:image/"):
            return s
        try:
            parsed = json.loads(s)
            found = _find_image_url_or_data(parsed)
            if found:
                return found
        except Exception:
            pass
        import re
        m = re.search(r"data:image/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\n\r]+", s)
        if m:
            return m.group(0).replace("\n", "").replace("\r", "")
        m = re.search(r"https?://[^\s\"'<>]+", s)
        if m:
            return m.group(0).rstrip("，,。.;；)")
        return ""
    if isinstance(value, list):
        for item in value:
            found = _find_image_url_or_data(item)
            if found:
                return found
        return ""
    if isinstance(value, dict):
        for key in ("dataUrl", "data_url", "image_url", "url", "b64_json", "b64", "base64"):
            if key in value:
                v = value.get(key)
                if isinstance(v, dict):
                    v = v.get("url") or v.get("dataUrl")
                if key in {"b64_json", "b64", "base64"} and v:
                    return str(v) if str(v).startswith("data:image/") else "data:image/png;base64," + str(v)
                found = _find_image_url_or_data(v)
                if found:
                    return found
        for v in value.values():
            found = _find_image_url_or_data(v)
            if found:
                return found
    return ""


def _image_from_chat_response(data: dict) -> str:
    content = _deep_get(data, ("choices", 0, "message", "content"), default="")
    found = _find_image_url_or_data(content)
    if found:
        return found
    return _find_image_url_or_data(data)


def _normalize_generated_image_blob(blob: bytes, mime: str, ratio: str) -> Tuple[bytes, str]:
    if not blob or Image is None:
        return blob, mime or "image/png"
    try:
        im = Image.open(io.BytesIO(blob))
        im = ImageOps.exif_transpose(im) if ImageOps else im
        im = im.convert("RGB")
        if ImageEnhance:
            im = ImageEnhance.Color(im).enhance(1.03)
            im = ImageEnhance.Contrast(im).enhance(1.02)
            im = ImageEnhance.Sharpness(im).enhance(1.02)
        out = io.BytesIO()
        im.save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png"
    except Exception:
        return blob, mime or "image/png"


async def _generated_image_to_data_url(client: httpx.AsyncClient, output: str, ratio: str = "3:4") -> str:
    """Normalize provider output so the browser never has to fetch a third-party image URL."""
    out = (output or "").strip()
    if not out:
        return out
    if out.startswith("data:image/"):
        try:
            name, blob, mime = _data_url_to_file(out, "generated.png")
            blob, mime = _normalize_generated_image_blob(blob, mime, ratio)
            return "data:%s;base64,%s" % (mime, base64.b64encode(blob).decode("ascii"))
        except Exception:
            return out
    if not out.startswith(("http://", "https://")):
        return out
    async def _get(c: httpx.AsyncClient):
        return await c.get(
            out,
            headers={"Accept": "image/*", "Accept-Encoding": "identity"},
            timeout=httpx.Timeout(120.0, connect=12.0),
        )
    try:
        if getattr(client, "is_closed", False):
            async with httpx.AsyncClient(**_httpx_async_client_kwargs(timeout=httpx.Timeout(120.0, connect=12.0), trust_env=False, follow_redirects=True)) as fresh:
                resp = await _get(fresh)
        else:
            resp = await _get(client)
    except httpx.HTTPError as exc:
        raise HTTPException(502, "图片已生成，但服务器下载成图失败：%s %s" % (exc.__class__.__name__, exc))
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, "图片已生成，但服务器下载成图失败：HTTP %s" % resp.status_code)
    blob = resp.content or b""
    if not _looks_like_image_blob(blob):
        raise HTTPException(502, "图片已生成，但返回地址不是有效图片文件")
    mime = (resp.headers.get("content-type") or "").split(";")[0].strip()
    if not mime.startswith("image/"):
        if blob.startswith(b"\x89PNG\r\n\x1a\n"):
            mime = "image/png"
        elif blob[:3] == b"\xff\xd8\xff":
            mime = "image/jpeg"
        elif blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
            mime = "image/webp"
        else:
            mime = "image/png"
    blob, mime = _normalize_generated_image_blob(blob, mime, ratio)
    return "data:%s;base64,%s" % (mime, base64.b64encode(blob).decode("ascii"))


def _responses_input(prompt: str, ref_files: List[Tuple[str, bytes, str]]):
    if not ref_files:
        return prompt
    content = [{"type": "input_text", "text": prompt}]
    for _, blob, mime in ref_files[:8]:
        content.append({"type": "input_image", "image_url": _image_ref_to_data_url(blob, mime)})
    return [{"role": "user", "content": content}]


def _maas_image_body(prompt: str, model: str, ratio: str, ref_files: List[Tuple[str, bytes, str]]):
    # TokenHub Image2 defaults to a square canvas unless the native legal size is
    # sent explicitly. Keep this as a model-side canvas request, not a postprocess
    # crop/pad/resize step.
    body = {
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": _image_size(ratio),
        "response_format": "b64_json",
        "output_format": "jpeg",
        "logo_add": 0,
    }
    if ref_files:
        body["images"] = [{"image_url": _image_ref_to_data_url(blob, mime)} for _, blob, mime in ref_files[:8]]
        body["input_fidelity"] = "high"
    return body


def _looks_like_image_blob(blob: bytes) -> bool:
    return (
        blob.startswith(b"\x89PNG\r\n\x1a\n") or
        blob.startswith(b"\xff\xd8\xff") or
        blob.startswith(b"GIF87a") or
        blob.startswith(b"GIF89a") or
        blob.startswith(b"RIFF")
    )


def _local_api_origin() -> str:
    return "http://127.0.0.1:%s" % os.getenv("PORT", "8787")


def _is_image_busy_error(detail: str) -> bool:
    s = str(detail or "").lower()
    return (
        "任务上限" in s or
        "code:1002" in s or
        ("1002" in s and "任务" in s) or
        "too many" in s or
        "concurrency" in s or
        "rate limit" in s
    )


async def _post_json_with_retry(client: httpx.AsyncClient, endpoint: str, body: dict, headers: dict, retries: int = 24):
    last_r = None
    last_data = None
    for attempt in range(retries + 1):
        async with IMAGE_SUBMIT_QUEUE:
            r = await client.post(endpoint, json=body, headers=headers)
        last_r = r
        ctype = r.headers.get("content-type") or ""
        try:
            data = r.json() if "json" in ctype else {"raw": r.text[:4000]}
        except Exception:
            data = {"raw": r.text[:4000]}
        last_data = data
        if r.status_code < 400:
            return r, data
        detail = _http_detail(data) if data else r.text[:1000]
        if _is_image_busy_error(detail) and attempt < retries:
            await asyncio.sleep(min(3 + attempt * 2, 12))
            continue
        return r, data
    return last_r, last_data


async def _post_image_form_with_retry(client: httpx.AsyncClient, endpoint: str, *, data, files, headers, retries: int = 24):
    last_response = None
    for attempt in range(retries + 1):
        async with IMAGE_SUBMIT_QUEUE:
            response = await client.post(endpoint, data=data, files=files, headers=headers)
        last_response = response
        try:
            payload = response.json()
        except Exception:
            payload = None
        detail = _http_detail(payload) if payload else response.text[:1000]
        if response.status_code >= 400 and _is_image_busy_error(detail) and attempt < retries:
            await asyncio.sleep(min(3 + attempt * 2, 12))
            continue
        return response
    return last_response


def _data_url_to_file(data_url: str, name: str = "reference.png") -> Tuple[str, bytes, str]:
    head, b64 = data_url.split(",", 1)
    mime = "image/png"
    if head.startswith("data:") and ";" in head:
        mime = head[5:].split(";", 1)[0] or mime
    ext = mimetypes.guess_extension(mime) or ".png"
    safe = (name or "reference").replace("/", "_").replace("\\", "_")
    if "." not in safe:
        safe += ext
    return safe, base64.b64decode(b64), mime


async def _collect_image_ref_files(client: httpx.AsyncClient, refs: List[ImageRef]) -> List[Tuple[str, bytes, str]]:
    files = []
    for i, ref in enumerate((refs or [])[:8]):
        data_url = (ref.dataUrl or "").strip()
        url = (ref.url or "").strip()
        role = "custom" if (ref.role or "").lower() == "custom" else "shared"
        name = ("%s_%s" % (role, ref.name or ("reference_%d.png" % (i + 1)))).strip()
        if data_url.startswith("data:image/"):
            try:
                files.append(_data_url_to_file(data_url, name))
            except Exception:
                continue
            continue
        if url.startswith("/"):
            url = _local_api_origin() + url
        if url and url.startswith(("http://", "https://")):
            try:
                r = await client.get(url, timeout=httpx.Timeout(60.0, connect=8.0), **_httpx_get_redirect_kwargs())
                ctype = (r.headers.get("content-type") or ref.mime or "").split(";")[0]
                if r.status_code < 400 and (ctype.startswith("image/") or _looks_like_image_blob(r.content)):
                    mime = ctype if ctype.startswith("image/") else (ref.mime or "image/png")
                    ext = mimetypes.guess_extension(mime) or ".png"
                    safe = (name or ("reference_%d" % (i + 1))).replace("/", "_").replace("\\", "_")
                    if "." not in safe:
                        safe += ext
                    files.append((safe, r.content, mime))
            except Exception:
                continue
    return files


def _image_ref_to_data_url(blob: bytes, mime: str = "image/png") -> str:
    return "data:%s;base64,%s" % (mime or "image/png", base64.b64encode(blob).decode("ascii"))


def _image_ref_data_url_size(blob: bytes, mime: str = "image/png") -> int:
    """Return the serialized byte cost of a data-URL image reference."""
    prefix = "data:%s;base64," % (mime or "image/png")
    return len(prefix.encode("ascii")) + 4 * ((len(blob) + 2) // 3)


def _compact_image_reference(blob: bytes, mime: str, max_data_url_bytes: int) -> Tuple[bytes, str, bool]:
    """Shrink a raster reference without dropping it from the model request."""
    if _image_ref_data_url_size(blob, mime) <= max_data_url_bytes:
        return blob, mime, False
    if Image is None:
        return _compact_image_reference_with_ffmpeg(blob, max_data_url_bytes)
    try:
        source = Image.open(io.BytesIO(blob))
        source = ImageOps.exif_transpose(source) if ImageOps else source
        if source.mode in {"RGBA", "LA"}:
            background = Image.new("RGB", source.size, "white")
            alpha = source.getchannel("A") if "A" in source.getbands() else None
            background.paste(source.convert("RGB"), mask=alpha)
            source = background
        else:
            source = source.convert("RGB")
    except Exception as exc:
        raise HTTPException(400, "参考图无法读取或压缩：%s" % exc.__class__.__name__)

    longest = max(source.size or (1, 1))
    max_edge = min(longest, 2048)
    resampling = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
    while max_edge >= 320:
        scale = min(1.0, max_edge / float(longest))
        if scale < 1.0:
            size = (max(1, round(source.width * scale)), max(1, round(source.height * scale)))
            image = source.resize(size, resampling)
        else:
            image = source
        for quality in (86, 80, 74, 68, 60, 52):
            out = io.BytesIO()
            image.save(out, format="JPEG", quality=quality, optimize=True, progressive=True)
            compacted = out.getvalue()
            if _image_ref_data_url_size(compacted, "image/jpeg") <= max_data_url_bytes:
                return compacted, "image/jpeg", True
        max_edge = int(max_edge * 0.72)
    raise HTTPException(413, "参考图压缩后仍超过图片模型的请求上限；请减少参考图数量后重试")


def _compact_image_reference_with_ffmpeg(blob: bytes, max_data_url_bytes: int) -> Tuple[bytes, str, bool]:
    """Production fallback for hosts that intentionally omit Pillow from their venv."""
    if not shutil.which("ffmpeg"):
        raise HTTPException(413, "参考图过大，服务器缺少图片压缩能力；请减少参考图数量后重试")
    for max_edge in (2048, 1600, 1280, 960, 720, 512, 384, 320):
        for quality in (4, 7, 10, 14, 18, 23, 28, 31):
            try:
                result = subprocess.run(
                    [
                        "ffmpeg", "-v", "error", "-nostdin", "-i", "pipe:0", "-frames:v", "1",
                        "-vf", "scale='min(%d,iw)':'min(%d,ih)':force_original_aspect_ratio=decrease" % (max_edge, max_edge),
                        "-q:v", str(quality), "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
                    ],
                    input=blob,
                    capture_output=True,
                    timeout=20,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            compacted = result.stdout or b""
            if _looks_like_image_blob(compacted) and _image_ref_data_url_size(compacted, "image/jpeg") <= max_data_url_bytes:
                return compacted, "image/jpeg", True
    raise HTTPException(413, "参考图压缩后仍超过图片模型的请求上限；请减少参考图数量后重试")


def _compact_image_ref_files(ref_files: List[Tuple[str, bytes, str]]) -> Tuple[List[Tuple[str, bytes, str]], int]:
    """Apply a shared payload budget across all references before calling providers."""
    active = list(ref_files[:8])
    if not active:
        return active, 0
    per_ref_budget = min(
        IMAGE_REFERENCE_MAX_DATA_URL_BYTES,
        max(96_000, IMAGE_REFERENCE_TOTAL_DATA_URL_BYTES // len(active)),
    )
    compacted = []
    changed = 0
    for name, blob, mime in active:
        next_blob, next_mime, did_compact = _compact_image_reference(blob, mime, per_ref_budget)
        compacted.append((name, next_blob, next_mime))
        changed += int(did_compact)
    total_size = sum(_image_ref_data_url_size(blob, mime) for _, blob, mime in compacted)
    if total_size > IMAGE_REFERENCE_TOTAL_DATA_URL_BYTES:
        raise HTTPException(413, "参考图总大小超过图片模型请求上限；请减少参考图数量后重试")
    return compacted, changed


@app.get("/api/llm/config")
def llm_config(_me=Depends(require_creator)):
    reachable, detail = _resolve_base(LLM_ENDPOINT)
    return {
        "ok": True,
        "configured": bool(LLM_API_KEY),
        "model": LLM_MODEL,
        "endpoint": _mask_endpoint(LLM_ENDPOINT),
        "baseUrl": _public_base(LLM_ENDPOINT),
        "forceModel": LLM_FORCE_MODEL,
        "thinking": LLM_THINKING or "default",
        "maxTokens": LLM_MAX_TOKENS or None,
        "reachable": reachable,
        "detail": detail,
    }


@app.post("/api/llm/test")
async def llm_test(_me=Depends(require_creator)):
    if not LLM_API_KEY:
        raise HTTPException(500, "服务器未配置 LLM_API_KEY")
    body = {
        "model": LLM_MODEL,
        "temperature": 0,
        "messages": [{"role": "user", "content": "请只回复：在线"}],
    }
    r = await _call_llm(body)
    if r.status_code >= 400:
        raise _llm_error(r.status_code, _http_detail(r.json() if "json" in (r.headers.get("content-type") or "") else r.text[:800]))
    data = r.json()
    content = _clean_llm_text(_deep_get(data, ("choices", 0, "message", "content"), default=""))
    return {"ok": True, "model": LLM_MODEL, "content": content, "endpoint": _mask_endpoint(LLM_ENDPOINT)}


@app.post("/api/llm")
async def llm_proxy(req: LLMReq, _me=Depends(require_creator)):
    """前端 / CLI 统一从这里调模型，Key 只存在服务器环境变量里。"""
    if not LLM_API_KEY:
        raise HTTPException(500, "服务器未配置 LLM_API_KEY")
    body = {"model": LLM_MODEL, "temperature": req.temperature, "messages": req.messages}
    if req.json_mode:
        body["response_format"] = {"type": "json_object"}
    r = await _call_llm(body)
    if r.status_code != 200:
        try:
            detail = _http_detail(r.json())
        except Exception:
            detail = r.text[:800]
        raise _llm_error(r.status_code, detail)
    data = r.json()
    content = _clean_llm_text(_deep_get(data, ("choices", 0, "message", "content"), default=""))
    if not content:
        raise _llm_error(502, "模型无有效返回")
    return {"content": content}


@app.post("/api/llm/vision-copy")
async def llm_vision_copy(req: VisionCopyReq, _me=Depends(require_creator)):
    """单图创作：让已配置的视觉语言模型看最终成图，再写发布标题与正文。"""
    if not LLM_API_KEY:
        raise HTTPException(500, "服务器未配置语言模型")
    image = str(req.imageDataUrl or "").strip()
    if not re.match(r"^data:image/(?:png|jpe?g|webp);base64,", image, flags=re.I):
        raise HTTPException(400, "图片数据格式不支持")
    if len(image) > 16 * 1024 * 1024:
        raise HTTPException(413, "图片过大，请压缩后重试")
    style = str(req.accountStyle or "").strip()[:800]
    body = {
        "model": LLM_VISION_MODEL or LLM_MODEL,
        "temperature": 0.78,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": (
                    "请仔细看这张最终成图，先理解画面中的主体、文字、动作、场景和信息关系，"
                    "再生成可直接发布的中文标题与正文。不要引入图片里没有的新产品能力或新主题。"
                    "正文应自然、有信息量，末尾带4到7个相关话题标签。"
                    + ("账号表达风格仅供语气参考：" + style if style else "")
                    + "。只输出JSON：{\"title\":\"标题\",\"copy\":\"正文和标签\"}"
                )},
                {"type": "image_url", "image_url": {"url": image}},
            ],
        }],
    }
    r = await _call_llm(body, force_deployed_model=not bool(LLM_VISION_MODEL))
    if r.status_code >= 400:
        try:
            detail = _http_detail(r.json())
        except Exception:
            detail = r.text[:500]
        raise _llm_error(r.status_code, detail)
    data = r.json()
    content = _clean_llm_text(_deep_get(data, ("choices", 0, "message", "content"), default=""))
    if not content:
        raise HTTPException(502, "视觉模型没有返回文案")
    return {"content": content}


@app.post("/api/chat/completions")
async def chat_completions_proxy(req: Request, _me=Depends(require_creator)):
    """OpenAI 兼容透传：前端语言模型 Provider 指到这里即可，免浏览器跨域、Key 藏服务器。
    请求体原样转发到 LLM_ENDPOINT，响应原样返回（保留 choices 结构供前端解析）。
    只使用服务器环境变量 LLM_API_KEY；成员 Bearer token 仅用于平台身份校验。"""
    raw = await req.body()
    if not LLM_API_KEY:
        raise HTTPException(500, "服务器未配置 LLM_API_KEY")
    auth = f"Bearer {LLM_API_KEY}"
    try:
        body = json.loads(raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
    except Exception:
        raise HTTPException(400, "请求体不是合法 JSON")
    r = await _call_llm(body, auth)
    if r.status_code >= 400:
        try:
            detail = _http_detail(r.json())
        except Exception:
            detail = r.text[:800]
        raise _llm_error(r.status_code, detail)
    return Response(content=r.content, status_code=r.status_code, media_type="application/json")


@app.get("/api/image/config")
def image_config(_me=Depends(require_creator)):
    endpoint = _image_endpoint()
    reachable, detail = _resolve_base(endpoint)
    return {
        "ok": True,
        "configured": bool(IMAGE_API_KEY),
        "reachable": reachable,
        "detail": detail,
        "model": IMAGE_MODEL,
        "referenceReceipt": True,
        "mode": (
            "responses" if _image_is_responses_mode(endpoint=endpoint)
            else ("chat" if _image_is_chat_mode(endpoint=endpoint)
                  else ("gpt-maas" if _image_is_maas_mode(endpoint=endpoint) else "images"))
        ),
        "endpoint": _mask_endpoint(endpoint),
        "baseUrl": _public_base(endpoint),
    }


@app.post("/api/image/generate")
async def image_generate(req: ImageGenerateReq, _me=Depends(require_creator)):
    """同源图片生成代理：解决浏览器跨域，并保留最多 5 张参考图。
    服务器托管模式只使用服务器配置；本地客户端 Key 模式仅允许白名单端点。"""
    api_key, endpoint, edit_endpoint = _image_request_config(req)
    raw_prompt = (req.prompt or "").strip()
    if not raw_prompt:
        raise HTTPException(400, "图片提示词为空")
    prompt = _guard_image_prompt(raw_prompt)
    ratio = (
        _normalize_image_ratio(req.ratio)
        if req.strictRatio
        else _infer_image_ratio_from_prompt(raw_prompt, _normalize_image_ratio(req.ratio))
    )
    model = _image_model_for_request(req.model, endpoint)
    responses_mode = _image_is_responses_mode(model=model, endpoint=endpoint)
    maas_mode = (not responses_mode) and _image_is_maas_mode(model=model, endpoint=endpoint)
    chat_mode = (not responses_mode and not maas_mode) and _image_is_chat_mode(model=model, endpoint=endpoint)
    body = {
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": _image_size(ratio),
    }
    json_headers = {
        "Authorization": "Bearer " + api_key,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
    }
    upload_headers = {
        "Authorization": "Bearer " + api_key,
        "Accept": "application/json",
        "Accept-Encoding": "identity",
    }
    used_refs = 0
    skipped_refs = 0
    request_endpoint = endpoint
    try:
        async with httpx.AsyncClient(**_httpx_async_client_kwargs(timeout=httpx.Timeout(180.0, connect=12.0), trust_env=False, follow_redirects=True)) as client:
            ref_files = await _collect_image_ref_files(client, req.refs or [])
            ref_files, compacted_refs = _compact_image_ref_files(ref_files)
            skipped_refs = max(0, len(req.refs or []) - len(ref_files))
            if maas_mode:
                used_refs = min(len(ref_files), 8)
                maas_prompt = prompt
                if used_refs:
                    maas_prompt += "\n\n参考随消息附带的 %d 张参考图；以本次提示词的主题和文字内容为准。" % used_refs
                maas_model = _maas_model_for_refs(req.model or model, bool(ref_files))
                maas_body = _maas_image_body(maas_prompt, maas_model, ratio, ref_files)
                request_endpoint = _maas_endpoint_for_refs(endpoint, bool(ref_files))
                r, data = await _post_json_with_retry(client, request_endpoint, maas_body, json_headers)
            elif responses_mode:
                used_refs = min(len(ref_files), 8)
                ref_note = ""
                if used_refs:
                    ref_note = "\n\n参考随消息附带的 %d 张参考图；以本次提示词的主题和文字内容为准。" % used_refs
                response_body = {
                    "model": model,
                    "instructions": "你是专业图片生成模型。按用户中文提示生成一张可用于小红书笔记的图片，并返回图片结果。",
                    "input": _responses_input(prompt + ref_note, ref_files),
                    "stream": False
                }
                r, data = await _post_json_with_retry(client, endpoint, response_body, json_headers)
            elif chat_mode:
                content = [{"type": "text", "text": prompt}]
                for idx, (name, blob, mime) in enumerate(ref_files[:8], start=1):
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": _image_ref_to_data_url(blob, mime)}
                    })
                ref_note = ""
                if ref_files:
                    used_refs = len(ref_files[:8])
                    ref_note = "\n\n参考随消息附带的 %d 张参考图；以本次提示词的主题和文字内容为准。" % used_refs
                    content[0]["text"] = prompt + ref_note
                chat_body = {
                    "model": model,
                    "messages": [
                        {"role": "system", "content": "你是专业图片生成模型。按用户中文提示生成一张可用于小红书笔记的图片，并返回图片结果。"},
                        {"role": "user", "content": content if used_refs else (prompt + ref_note)}
                    ],
                    "stream": False
                }
                r, data = await _post_json_with_retry(client, endpoint, chat_body, json_headers)
            elif ref_files:
                form = {"model": model, "prompt": prompt, "n": "1", "size": body["size"]}
                file_parts = [("image", (name, blob, mime)) for name, blob, mime in ref_files]
                r = await _post_image_form_with_retry(client, edit_endpoint, data=form, files=file_parts, headers=upload_headers)
                data = r.json() if "json" in (r.headers.get("content-type") or "") else {}
                if r.status_code >= 400:
                    file_parts = [("image[]", (name, blob, mime)) for name, blob, mime in ref_files]
                    r = await _post_image_form_with_retry(client, edit_endpoint, data=form, files=file_parts, headers=upload_headers)
                    data = r.json() if "json" in (r.headers.get("content-type") or "") else {}
                if r.status_code >= 400:
                    detail = _http_detail(data) if data else r.text[:1000]
                    raise HTTPException(r.status_code, "参考图未被图片 API 接收：" + (detail or "图片编辑接口失败"))
                used_refs = len(ref_files)
            else:
                r, data = await _post_json_with_retry(client, endpoint, body, json_headers)
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(502, "无法连接图片 API（%s）：%s %s" % (_public_base(request_endpoint), exc.__class__.__name__, exc))
    except Exception as exc:
        raise HTTPException(502, "图片 API 适配失败：%s %s" % (exc.__class__.__name__, str(exc)[:240]))
    if r.status_code >= 400:
        detail = _http_detail(data) if data else r.text[:1000]
        raise HTTPException(r.status_code, detail or "图片生成失败")
    if isinstance(data, dict) and (data.get("error") or str(data.get("status") or "").lower() == "failed"):
        detail = _http_detail(data) or "图片生成失败"
        raise HTTPException(502, detail)
    try:
        output = _find_image_url_or_data(data) if responses_mode else (_image_from_chat_response(data) if chat_mode else _image_from_response(data, "image/jpeg" if maas_mode else "image/png"))
        if not output:
            raise HTTPException(502, "图片 API 没有返回图片数据")
        output = await _generated_image_to_data_url(client, output, ratio)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, "图片 API 返回已收到，但服务端解析失败：%s %s" % (exc.__class__.__name__, str(exc)[:240]))
    return {
        "ok": True,
        "dataUrl": output,
        "model": model,
        "usedRefs": used_refs,
        "skippedRefs": skipped_refs,
        "compressedRefs": compacted_refs,
        "ratio": ratio,
        "mode": "responses" if responses_mode else ("chat" if chat_mode else ("gpt-maas" if maas_mode else "images"))
    }


# ---------- 视频生成代理：Seedance ----------
class VideoRef(BaseModel):
    id: Optional[str] = None
    name: str = ""
    type: str = "图片"
    mime: str = ""
    tags: List[str] = []
    url: str = ""
    dataUrl: str = ""


class VideoSubmitReq(BaseModel):
    prompt: str
    refs: List[VideoRef] = []
    ratio: str = "9:16"
    duration: int = 15
    resolution: Optional[str] = None
    generateAudio: Optional[bool] = None
    model: Optional[str] = None


class FileProxyReq(BaseModel):
    url: str


class ComposeClip(BaseModel):
    url: str
    name: str = ""
    dur: Optional[float] = None
    trimIn: Optional[float] = 0


class ComposeSubtitle(BaseModel):
    start: float = 0
    end: float = 0
    text: str = ""


class ComposeSubtitleStyle(BaseModel):
    size: float = 11
    stroke: float = 1
    bottom: float = 22


class ComposeReq(BaseModel):
    clips: List[ComposeClip]
    title: str = "final"
    narrationUrl: str = ""
    narrationDataUrl: str = ""
    bgmUrl: str = ""
    bgmDataUrl: str = ""
    bgmVolume: float = 0.25
    narrationVolume: float = 1.0
    preserveClipAudio: bool = False
    transitionDuration: float = 0.0
    subtitleStyle: ComposeSubtitleStyle = ComposeSubtitleStyle()
    subtitles: List[ComposeSubtitle] = []


def _video_status(data: dict) -> str:
    d1 = data.get("data") if isinstance(data.get("data"), dict) else {}
    d2 = d1.get("data") if isinstance(d1.get("data"), dict) else {}
    s = str(data.get("status") or d1.get("status") or d2.get("task_status") or d2.get("taskStatus") or "").lower()
    if s in {"succeeded", "completed", "success", "done", "succeed"}:
        return "succeeded"
    if s in {"failed", "fail", "failure", "error", "expired"}:
        return "failed"
    return "running"


def _readable_error(value) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get("message") or value.get("msg") or value.get("status_msg") or value.get("detail") or json.dumps(value, ensure_ascii=False)[:800]
    return str(value)


def _http_detail(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        msg = (
            value.get("detail") or value.get("message") or value.get("msg") or
            _readable_error(value.get("error")) or _readable_error(value.get("base_resp"))
        )
        return str(msg or json.dumps(value, ensure_ascii=False)[:800])
    return str(value or "")


def _normalize_provider_error(text: str) -> str:
    s = str(text or "")
    if not s:
        return ""
    if "InputImageSensitiveContent" in s:
        return "参考图未通过 Seedance 图片安全检测。请换一张更清晰、无敏感元素的参考图，或先移除参考图后重试。"
    if "InvalidEndpointOrModel.NotFound" in s and any(x in s.lower() for x in ("omni", "human")):
        return (
            "数字人模型未开通或模型 ID 不属于当前 Ark 视频任务接口。"
            "Seedance 2.0 可继续使用；OmniHuman 1.5 需要在即梦/智能视觉服务侧开通并提供对应接口或准确模型 ID 后再接入。"
        )
    return s


def _video_progress(data: dict, status: str) -> int:
    if status == "succeeded":
        return 100
    if status == "failed":
        return 0
    d1 = data.get("data") if isinstance(data.get("data"), dict) else {}
    d2 = d1.get("data") if isinstance(d1.get("data"), dict) else {}
    raw = data.get("progress") or d1.get("progress") or d2.get("progress")
    try:
        n = int(float(str(raw or "").replace("%", "")))
        return max(1, min(99, n))
    except Exception:
        return 55


def _video_error(data: dict) -> str:
    d1 = data.get("data") if isinstance(data.get("data"), dict) else {}
    d2 = d1.get("data") if isinstance(d1.get("data"), dict) else {}
    msg = (
        _readable_error(data.get("error")) or _readable_error(data.get("detail")) or _readable_error(data.get("message")) or
        _readable_error(d1.get("error")) or _readable_error(d1.get("fail_reason")) or _readable_error(d1.get("message")) or
        _readable_error(d2.get("error")) or _readable_error(d2.get("fail_reason")) or _readable_error(d2.get("task_status_msg")) or _readable_error(d2.get("message")) or
        "Seedance 生成失败"
    )
    return _normalize_provider_error(msg)


def _find_video_url(obj) -> str:
    if isinstance(obj, str):
        return obj if obj.startswith("http") else ""
    if isinstance(obj, list):
        for item in obj:
            found = _find_video_url(item)
            if found:
                return found
    if isinstance(obj, dict):
        for key in ("video_url", "videoUrl", "result_url", "url"):
            v = obj.get(key)
            if isinstance(v, str) and v.startswith("http"):
                return v
        for value in obj.values():
            found = _find_video_url(value)
            if found:
                return found
    return ""


def _local_server_file_path(url: str) -> Optional[Path]:
    raw = str(url or "").strip()
    if not raw:
        return None
    path = urlparse(raw).path if raw.startswith(("http://", "https://")) else raw
    path = path.split("?", 1)[0].split("#", 1)[0]
    if path.startswith("/api/video/composed/"):
        local = COMPOSED_DIR / Path(path[len("/api/video/composed/"):]).name
    elif path.startswith("/api/files/"):
        local = UPLOAD_DIR / Path(path[len("/api/files/"):]).name
    else:
        return None
    try:
        local.resolve().relative_to(local.parent.resolve())
    except Exception:
        return None
    return local


def _stable_local_video_url(url: str) -> str:
    raw = str(url or "").strip()
    path = urlparse(raw).path if raw.startswith(("http://", "https://")) else raw
    path = path.split("?", 1)[0].split("#", 1)[0]
    if path.startswith("/api/video/composed/"):
        return "/api/video/composed/" + Path(path[len("/api/video/composed/"):]).name
    if path.startswith("/api/files/"):
        return "/api/files/" + Path(path[len("/api/files/"):]).name
    return ""


async def _download_binary(client: httpx.AsyncClient, url: str, label: str, max_bytes: int = VIDEO_OUTPUT_CACHE_MAX_BYTES) -> bytes:
    try:
        r = await client.get(url, **_httpx_get_redirect_kwargs())
    except httpx.HTTPError as exc:
        raise RuntimeError(f"{label}下载失败：{exc.__class__.__name__}")
    if r.status_code >= 400:
        raise RuntimeError(f"{label}下载失败：HTTP {r.status_code}")
    data = r.content or b""
    if not data:
        raise RuntimeError(f"{label}下载失败：文件为空")
    if max_bytes > 0 and len(data) > max_bytes:
        raise RuntimeError(f"{label}下载失败：文件过大")
    return data


async def _cache_generated_video_output(video_url: str, prefix: str) -> Tuple[str, str]:
    raw = str(video_url or "").strip()
    if not raw:
        return "", ""
    stable = _stable_local_video_url(raw)
    if stable:
        local = _local_server_file_path(stable)
        if local and local.exists() and local.stat().st_size > 0:
            return stable, ""
        return "", "视频已生成，但服务器缓存文件暂不可读取，请重试生成。"
    if not raw.startswith(("http://", "https://")):
        return raw, ""
    COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:18]
    out_name = f"{prefix}_{digest}.mp4"
    out_path = COMPOSED_DIR / out_name
    if out_path.exists() and out_path.stat().st_size > 0:
        return f"/api/video/composed/{out_name}", ""
    tmp_path = out_path.with_suffix(".tmp")
    try:
        async with httpx.AsyncClient(**_httpx_async_client_kwargs(
            timeout=httpx.Timeout(240.0, connect=12.0),
            trust_env=False,
            follow_redirects=True
        )) as client:
            data = await _download_binary(client, raw, "成片")
        tmp_path.write_bytes(data)
        tmp_path.replace(out_path)
        return f"/api/video/composed/{out_name}", ""
    except Exception:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass
        return "", "视频已生成，但服务器缓存成片失败；请稍后重试该段，避免直接播放上游临时地址。"


def _public_base(url: str) -> str:
    parts = url.split("/")
    return f"{parts[0]}//{parts[2]}/***" if len(parts) > 2 else "***"


def _ffmpeg_bin() -> str:
    local = FRONTEND_DIR / "bin" / "ffmpeg"
    if local.exists() and os.access(local, os.X_OK):
        return str(local)
    return shutil.which("ffmpeg") or ""


def _write_data_url(path: Path, data_url: str) -> bool:
    data_url = str(data_url or "")
    if not data_url.startswith("data:") or "," not in data_url:
        return False
    try:
        path.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
        return True
    except Exception:
        return False


def _resolve_base(url: str):
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        host = parsed.hostname or url.split("/")[2].split(":")[0]
        port = parsed.port or (443 if (parsed.scheme or "https") == "https" else 80)
        socket.gethostbyname(host)
        with socket.create_connection((host, port), timeout=3):
            pass
        return True, ""
    except Exception as e:
        return False, getattr(e, "strerror", "") or str(e)


def _join_url(base: str, path: str) -> str:
    base = (base or "").rstrip("/")
    path = "/" + str(path or "").lstrip("/")
    return base + path


def _first_number(obj, keys: Tuple[str, ...]) -> int:
    def norm_key(k):
        return re.sub(r"[^a-z0-9]", "", str(k or "").lower())
    wanted = {norm_key(k) for k in keys}
    stack = [obj]
    while stack:
        cur = stack.pop(0)
        if isinstance(cur, dict):
            for k, v in cur.items():
                if norm_key(k) in wanted:
                    raw = str(v).replace(",", "").strip()
                    m = re.search(r"-?\d+(?:\.\d+)?", raw)
                    if m:
                        try:
                            return int(float(m.group(0)))
                        except Exception:
                            pass
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return 0


def _first_text(obj, keys: Tuple[str, ...]) -> str:
    def norm_key(k):
        return re.sub(r"[^a-z0-9]", "", str(k or "").lower())
    wanted = {norm_key(k) for k in keys}
    stack = [obj]
    while stack:
        cur = stack.pop(0)
        if isinstance(cur, dict):
            for k, v in cur.items():
                if norm_key(k) in wanted and v not in (None, ""):
                    return str(v)
            stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    return ""


def _clean_social_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _text_candidates(obj, keys: Tuple[str, ...]) -> list:
    def norm_key(k):
        return re.sub(r"[^a-z0-9]", "", str(k or "").lower())
    wanted = {norm_key(k) for k in keys}
    found = []
    stack = [("", obj)]
    while stack:
        path, cur = stack.pop(0)
        if isinstance(cur, dict):
            for k, v in cur.items():
                child_path = f"{path}.{k}" if path else str(k)
                if norm_key(k) in wanted and v not in (None, ""):
                    text = _clean_social_text(v)
                    if text:
                        found.append((child_path, norm_key(k), text))
                stack.append((child_path, v))
        elif isinstance(cur, list):
            for i, v in enumerate(cur):
                stack.append((f"{path}[{i}]", v))
    return found


def _xhs_detail_title(detail: dict) -> str:
    candidates = _text_candidates(detail, ("title", "displayTitle", "display_title", "share_title"))

    def rank(item):
        path = item[0]
        if re.search(r"\.note_list\[\d+\]\.title$", path):
            return 0
        if path.endswith(".share_info.title"):
            return 1
        if re.search(r"\.(display_title|displayTitle)$", path):
            return 2
        if path.endswith(".title") and "mini_program_info" not in path and "qq_mini_program_info" not in path:
            return 3
        if path.endswith(".share_title"):
            return 4
        return 9

    for path, _, text in sorted(candidates, key=rank):
        if "mini_program_info" in path or "qq_mini_program_info" in path:
            continue
        if re.search(r"发了.*笔记|快点来看", text):
            continue
        return text
    return _clean_social_text(_first_text(detail, ("desc", "description")))


def _wechat_channels_title(basic: dict) -> str:
    candidates = _text_candidates(basic, ("title", "desc", "description"))

    def rank(item):
        path, key, _ = item
        if path.endswith(".data.title"):
            return 0
        if path.endswith(".title"):
            return 1
        if key in {"desc", "description"}:
            return 2
        return 9

    for _, _, text in sorted(candidates, key=rank):
        if text:
            return text
    return ""


def _extract_xhs_note_id(value: str) -> str:
    s = str(value or "")
    for pattern in (
        r"/explore/([A-Za-z0-9_-]+)",
        r"/discovery/item/([A-Za-z0-9_-]+)",
        r"(?:noteId|note_id|item_id)=([A-Za-z0-9_-]+)",
    ):
        m = re.search(pattern, s)
        if m:
            return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{16,40}", s.strip()):
        return s.strip()
    return ""


def _analytics_platform(req: AnalyticsJustOneReq) -> str:
    s = f"{req.platform or ''} {req.url or ''}".lower()
    if re.search(r"xiaohongshu|xhslink|\bxhs\b|小红书", s):
        return "小红书"
    if re.search(r"channels|weixin|wechat|finder|video\.qq\.com|视频号", s):
        return "视频号"
    return str(req.platform or "").strip() or "未知平台"


def _justone_metrics(data: dict) -> dict:
    views = _first_number(data, ("view_count", "views", "read_count", "readCount", "pv", "exposure_count", "impression_count", "play_count", "playCount"))
    likes = _first_number(data, ("liked_count", "like_count", "likes", "likedCount", "likeCount", "like_num"))
    collects = _first_number(data, ("collected_count", "collect_count", "favorite_count", "favorites", "collects", "collectedCount", "fav_count", "favoriteCount"))
    comments = _first_number(data, ("comment_count", "comments_count", "comments", "commentCount", "commentsCount", "comment_num"))
    shares = _first_number(data, ("share_count", "shared_count", "shares", "shareCount", "sharedCount", "forward_count", "forwardCount", "forward_num", "repost_count"))
    engagement = likes + collects + comments + shares
    engagement_rate = engagement / views if views else 0
    quality = round(min(96, max(30, engagement_rate * 520 + (views + 10) ** 0.12 * 12)))
    return {
        "views": views,
        "likes": likes,
        "collects": collects,
        "comments": comments,
        "shares": shares,
        "engagementRate": engagement_rate,
        "qualityScore": quality,
    }


def _justone_token_missing():
    if JUSTONE_API_KEY:
        return
    raise HTTPException(501, "JustOneAPI 数据接口已预留，等待在服务器环境配置 JUSTONE_API_KEY 或 JUSTONE_API_TOKEN")


async def _justone_get(path: str, params: dict) -> dict:
    _justone_token_missing()
    url = _join_url(JUSTONE_BASE_URL, path)
    query = {"token": JUSTONE_API_KEY, **{k: v for k, v in (params or {}).items() if v not in (None, "")}}
    try:
        async with httpx.AsyncClient(**_httpx_async_client_kwargs(timeout=JUSTONE_TIMEOUT, follow_redirects=True)) as client:
            r = await client.get(url, params=query)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"JustOneAPI 请求失败：{exc.__class__.__name__}")
    try:
        data = r.json()
    except Exception:
        raise HTTPException(502, "JustOneAPI 未返回 JSON")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, _readable_error(data) or f"JustOneAPI HTTP {r.status_code}")
    code = data.get("code") if isinstance(data, dict) else None
    if code not in (None, 0, "0"):
        raise HTTPException(502, _readable_error(data.get("message") or data.get("msg") or data.get("error")) or f"JustOneAPI 业务码 {code}")
    return data


async def _justone_post_form(path: str, params: dict) -> dict:
    _justone_token_missing()
    url = _join_url(JUSTONE_BASE_URL, path)
    form = {"token": JUSTONE_API_KEY, **{k: v for k, v in (params or {}).items() if v not in (None, "")}}
    try:
        async with httpx.AsyncClient(**_httpx_async_client_kwargs(timeout=JUSTONE_TIMEOUT, follow_redirects=True)) as client:
            r = await client.post(url, data=form, headers={"Content-Type": "application/x-www-form-urlencoded"})
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"JustOneAPI 请求失败：{exc.__class__.__name__}")
    try:
        data = r.json()
    except Exception:
        raise HTTPException(502, "JustOneAPI 未返回 JSON")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, _readable_error(data) or f"JustOneAPI HTTP {r.status_code}")
    code = data.get("code") if isinstance(data, dict) else None
    if code not in (None, 0, "0"):
        raise HTTPException(502, _readable_error(data.get("message") or data.get("msg") or data.get("error")) or f"JustOneAPI 业务码 {code}")
    return data


@app.get("/api/analytics/justoneapi/config")
def analytics_justone_config(_me=Depends(require_creator)):
    reachable, detail = _resolve_base(JUSTONE_BASE_URL)
    return {
        "ok": True,
        "provider": "JustOneAPI",
        "configured": bool(JUSTONE_API_KEY),
        "reachable": reachable,
        "detail": detail,
        "baseUrl": _public_base(JUSTONE_BASE_URL),
        "sharePath": JUSTONE_SHARE_PATH,
        "noteDetailPath": JUSTONE_NOTE_DETAIL_PATH,
        "wechatBasicPath": JUSTONE_WECHAT_BASIC_PATH,
        "wechatMetricsPath": JUSTONE_WECHAT_METRICS_PATH,
        "platforms": ["小红书", "视频号"],
    }


async def _fetch_xhs_metrics(req: AnalyticsJustOneReq):
    raw_url = str(req.url or "").strip()
    note_id = str(req.noteId or "").strip() or _extract_xhs_note_id(raw_url)
    resolved = None
    if not note_id and raw_url:
        resolved = await _justone_get(JUSTONE_SHARE_PATH, {"shareUrl": raw_url})
        note_id = (
            _first_text(resolved, ("noteId", "note_id", "itemId", "item_id", "id"))
            or _extract_xhs_note_id(json.dumps(resolved, ensure_ascii=False))
        )
    if not note_id:
        raise HTTPException(400, "未能从链接解析出小红书 noteId")
    detail = await _justone_get(JUSTONE_NOTE_DETAIL_PATH, {"noteId": note_id})
    metrics = _justone_metrics(detail)
    title = _xhs_detail_title(detail)
    return {
        "ok": True,
        "provider": "JustOneAPI",
        "platform": "小红书",
        "noteId": note_id,
        "title": title,
        "metrics": metrics,
        "raw": {"platform": "小红书", "noteId": note_id, "resolved": bool(resolved)},
    }


async def _fetch_wechat_channels_metrics(req: AnalyticsJustOneReq):
    raw_url = str(req.url or "").strip()
    legacy_object_id = str(req.noteId or "").strip()
    object_id = str(req.objectId or "").strip()
    if not object_id and re.fullmatch(r"\d{8,}", legacy_object_id):
        object_id = legacy_object_id
    object_nonce_id = str(req.objectNonceId or "").strip()
    basic = None
    if raw_url:
        basic = await _justone_get(JUSTONE_WECHAT_BASIC_PATH, {"feedInfo": raw_url})
        parsed_object_id = _first_text(basic, ("objectId", "object_id", "objectid", "id"))
        parsed_nonce = _first_text(basic, ("objectNonceId", "object_nonce_id", "nonceId", "nonce_id"))
        object_id = parsed_object_id or object_id
        object_nonce_id = parsed_nonce or object_nonce_id
    if not object_id:
        if not raw_url:
            raise HTTPException(400, "未提供视频号链接或 objectId")
        object_id = _first_text(basic, ("objectId", "object_id", "objectid", "id"))
        object_nonce_id = object_nonce_id or _first_text(basic, ("objectNonceId", "object_nonce_id", "nonceId", "nonce_id"))
    if not object_id:
        raise HTTPException(400, "未能从链接解析出视频号 objectId")
    metrics_res = await _justone_post_form(JUSTONE_WECHAT_METRICS_PATH, {
        "objectId": object_id,
        "objectNonceId": object_nonce_id,
    })
    metrics = _justone_metrics({"basic": basic or {}, "metrics": metrics_res})
    title = _wechat_channels_title(basic or {})
    return {
        "ok": True,
        "provider": "JustOneAPI",
        "platform": "视频号",
        "objectId": object_id,
        "objectNonceId": object_nonce_id,
        "title": title,
        "metrics": metrics,
        "raw": {"platform": "视频号", "objectId": object_id, "hasBasic": bool(basic)},
    }


@app.post("/api/analytics/justoneapi/fetch")
async def analytics_justone_fetch(
    req: AnalyticsJustOneReq,
    _me=Depends(require_creator),
):
    platform = _analytics_platform(req)
    if platform == "视频号":
        return await _fetch_wechat_channels_metrics(req)
    if platform == "小红书":
        return await _fetch_xhs_metrics(req)
    raise HTTPException(400, f"暂不支持该平台的数据监测：{platform}")


def _ref_url(ref: VideoRef) -> str:
    src = ref.dataUrl or ref.url or ""
    if not src or src.startswith("blob:"):
        return ""
    if src.startswith("data:"):
        return src
    if src.startswith(("http://localhost", "https://localhost", "http://127.0.0.1", "https://127.0.0.1")):
        if "/api/files/" in src:
            file_part = src[src.index("/api/files/") + len("/api/files/"):].split("?", 1)[0].split("#", 1)[0]
            if PUBLIC_BASE_URL:
                return PUBLIC_BASE_URL + "/api/files/" + file_part
            local_data_url = _local_upload_data_url(file_part)
            if local_data_url:
                return local_data_url
        return ""
    return src


def _local_upload_data_url(name: str) -> str:
    try:
        from urllib.parse import unquote
        path = _upload_path(unquote(name))
        if not path.exists() or not path.is_file():
            return ""
        mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        return "data:%s;base64,%s" % (mime, base64.b64encode(path.read_bytes()).decode("ascii"))
    except Exception:
        return ""


def _ref_kind(ref: VideoRef) -> str:
    text = f"{ref.type} {ref.mime} {ref.name}".lower()
    if "audio" in text or "音频" in text or "voice" in text or "声线" in text or "口播" in text:
        return "audio"
    if "video" in text or "视频" in text:
        return "video"
    return "image"


def _ref_role(ref: VideoRef, index: int) -> str:
    text = f"{ref.name} {' '.join(ref.tags or [])}"
    if any(x in text for x in ("last", "尾帧", "末帧")):
        return "last_frame"
    if any(x in text for x in ("first", "首帧")):
        return "first_frame"
    return "reference_image"


def _video_provider_name() -> str:
    if VIDEO_PROVIDER in {"ark", "volcengine", "volces", "jimeng"} or "volces" in SEEDANCE_BASE_URL or "ark." in SEEDANCE_BASE_URL:
        return "jimeng-ark"
    return VIDEO_PROVIDER or "seedance"


def _video_payload_mode() -> str:
    if SEEDANCE_PAYLOAD_MODE:
        return SEEDANCE_PAYLOAD_MODE
    return "ark" if _video_provider_name() == "jimeng-ark" else "metadata"


def _join_video_url(path: str) -> str:
    if path.startswith(("http://", "https://")):
        return path
    base = SEEDANCE_BASE_URL.rstrip("/")
    clean_path = "/" + path.lstrip("/")
    if base.endswith("/api/v3") and clean_path.startswith("/api/v3/"):
        clean_path = clean_path[len("/api/v3"):]
    if base.endswith("/api/v3/contents/generations/tasks") and clean_path.startswith("/api/v3/contents/generations/tasks"):
        clean_path = clean_path[len("/api/v3/contents/generations/tasks"):]
        if not clean_path:
            return base
    return f"{base}{clean_path}"


def _video_submit_url() -> str:
    if SEEDANCE_SUBMIT_PATH:
        return _join_video_url(SEEDANCE_SUBMIT_PATH)
    if _video_payload_mode() == "ark":
        return _join_video_url("/api/v3/contents/generations/tasks")
    return _join_video_url("/v1/video/generations")


def _video_poll_url(task_id: str) -> str:
    tid = task_id.strip()
    if SEEDANCE_POLL_PATH:
        return _join_video_url(SEEDANCE_POLL_PATH.replace("{task_id}", tid).replace("{id}", tid))
    if _video_payload_mode() == "ark":
        return _join_video_url(f"/api/v3/contents/generations/tasks/{tid}")
    return _join_video_url(f"/v1/video/generations/{tid}")


def _video_payload(req: VideoSubmitReq, content: list[dict]) -> dict:
    duration = max(4, min(15, int(req.duration or 15)))
    model = DIGITAL_HUMAN_MODEL if str(req.model or "").strip() == "__digital_human__" else (req.model or SEEDANCE_MODEL)
    if _video_payload_mode() == "ark":
        return {
            "model": model,
            "content": content,
            "ratio": req.ratio or "9:16",
            "duration": duration,
            "resolution": req.resolution or SEEDANCE_RESOLUTION,
            "watermark": SEEDANCE_WATERMARK,
            "generate_audio": SEEDANCE_GENERATE_AUDIO if req.generateAudio is None else req.generateAudio,
            "return_last_frame": True,
            "seed": -1,
        }
    return {
        "model": model,
        "prompt": "",
        "metadata": {
            "content": content,
            "ratio": req.ratio or "9:16",
            "duration": duration,
            "resolution": req.resolution or SEEDANCE_RESOLUTION,
            "watermark": SEEDANCE_WATERMARK,
            "generate_audio": SEEDANCE_GENERATE_AUDIO if req.generateAudio is None else req.generateAudio,
            "return_last_frame": True,
            "seed": -1,
        },
    }


def _is_digital_human_request(req: VideoSubmitReq) -> bool:
    return str(req.model or "").strip() == "__digital_human__"


def _digital_human_configured() -> bool:
    return bool(DIGITAL_HUMAN_ACCESS_KEY and DIGITAL_HUMAN_SECRET_KEY)


def _digital_human_task_id(task_id: str) -> str:
    tid = str(task_id or "").strip()
    return tid.split(":", 1)[1] if tid.startswith("omnihuman:") else tid


def _is_digital_human_task(task_id: str) -> bool:
    return str(task_id or "").strip().startswith("omnihuman:")


def _digital_human_url(action: str) -> str:
    return f"{DIGITAL_HUMAN_BASE_URL}/?Action={quote(action)}&Version=2022-08-31"


def _canonical_query(query: str) -> str:
    pairs = []
    for part in (query or "").split("&"):
        if not part:
            continue
        if "=" in part:
            k, v = part.split("=", 1)
        else:
            k, v = part, ""
        pairs.append((quote(k, safe="-_.~"), quote(v, safe="-_.~")))
    return "&".join(f"{k}={v}" for k, v in sorted(pairs))


def _volc_signed_headers(method: str, url: str, body: bytes) -> dict:
    if not _digital_human_configured():
        raise HTTPException(
            500,
            "OmniHuman 数字人未配置火山智能视觉 AK/SK：请配置 VOLC_ACCESS_KEY_ID 与 VOLC_SECRET_ACCESS_KEY，Ark API Key 不能直接调用该 CV 接口。"
        )
    parsed = urlparse(url)
    host = parsed.netloc
    payload_hash = hashlib.sha256(body).hexdigest()
    now = datetime.now(timezone.utc)
    x_date = now.strftime("%Y%m%dT%H%M%SZ")
    short_date = now.strftime("%Y%m%d")
    headers = {
        "content-type": "application/json",
        "host": host,
        "x-content-sha256": payload_hash,
        "x-date": x_date,
    }
    if DIGITAL_HUMAN_SECURITY_TOKEN:
        headers["x-security-token"] = DIGITAL_HUMAN_SECURITY_TOKEN
    signed_keys = sorted(headers.keys())
    canonical_headers = "".join(f"{k}:{headers[k].strip()}\n" for k in signed_keys)
    signed_headers = ";".join(signed_keys)
    canonical_request = "\n".join([
        method.upper(),
        parsed.path or "/",
        _canonical_query(parsed.query),
        canonical_headers,
        signed_headers,
        payload_hash,
    ])
    scope = f"{short_date}/{DIGITAL_HUMAN_REGION}/{DIGITAL_HUMAN_SERVICE}/request"
    string_to_sign = "\n".join([
        "HMAC-SHA256",
        x_date,
        scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])
    key = DIGITAL_HUMAN_SECRET_KEY.encode("utf-8")
    for item in (short_date, DIGITAL_HUMAN_REGION, DIGITAL_HUMAN_SERVICE, "request"):
        key = hmac.new(key, item.encode("utf-8"), hashlib.sha256).digest()
    signature = hmac.new(key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    headers["authorization"] = (
        f"HMAC-SHA256 Credential={DIGITAL_HUMAN_ACCESS_KEY}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return {k.title() if k != "authorization" else "Authorization": v for k, v in headers.items()}


def _cv_status(data: dict) -> str:
    d = data.get("data") if isinstance(data.get("data"), dict) else {}
    s = str(d.get("status") or data.get("status") or "").lower()
    if s in {"done", "succeeded", "success", "completed"}:
        return "succeeded"
    if s in {"expired", "not_found", "failed", "fail", "failure", "error"}:
        return "failed"
    return "running"


def _cv_error(data: dict) -> str:
    d = data.get("data") if isinstance(data.get("data"), dict) else {}
    msg = (
        _readable_error(data.get("message")) or _readable_error(data.get("msg")) or
        _readable_error(data.get("error")) or _readable_error(d.get("message")) or
        _readable_error(d.get("error")) or _readable_error(d.get("status_msg")) or
        "OmniHuman 数字人生成失败"
    )
    return msg


def _digital_human_transient_error(status_code: int = 0, data=None, text: str = "") -> bool:
    raw = ""
    if isinstance(data, dict):
        raw = json.dumps(data, ensure_ascii=False)
    else:
        raw = str(text or data or "")
    return bool(
        status_code in {429, 502, 503, 504} or
        re.search(r"Concurrent Limit|API Concurrent|Gateway Time-out|Gateway Timeout|TLB|timeout|timed out|Too Many Requests|限流|并发|网关超时", raw, re.I)
    )


def _digital_human_transient_detail(data=None, status_code: int = 0) -> str:
    if _digital_human_transient_error(status_code, data):
        return "OmniHuman 上游限流或网关超时，请稍后重试；系统会自动退避重试。"
    if isinstance(data, dict):
        return _http_detail(data) or f"OmniHuman 请求失败：status={status_code}"
    return str(data or f"OmniHuman 请求失败：status={status_code}")


def _video_submit_busy(status_code: int = 0, data=None, text: str = "") -> bool:
    raw = json.dumps(data, ensure_ascii=False) if isinstance(data, (dict, list)) else str(text or data or "")
    return bool(
        status_code in {429, 502, 503, 504} or
        re.search(
            r"Concurrent Limit|API Concurrent|Too Many Requests|rate.?limit|concurrenc|"
            r"Gateway Time|timeout|timed out|任务上限|排队已满|并发|限流|网关超时|code.?[:=]?\s*1002",
            raw,
            re.I,
        )
    )


async def _queued_video_post(client: httpx.AsyncClient, url: str, retries: int = 24, **kwargs):
    """提交类视频请求共享本机队列；上游并发满时继续排队并退避重试。"""
    last_response = None
    for attempt in range(retries + 1):
        async with VIDEO_SUBMIT_QUEUE:
            response = await client.post(url, **kwargs)
        last_response = response
        try:
            data = response.json()
        except Exception:
            data = None
        if _video_submit_busy(response.status_code, data, response.text[:1200]) and attempt < retries:
            await asyncio.sleep(min(3 + attempt * 2, 12))
            continue
        return response
    return last_response


async def _digital_human_submit(req: VideoSubmitReq, resolved_images, resolved_audios):
    if not _digital_human_configured():
        raise HTTPException(
            500,
            "OmniHuman 数字人未配置火山智能视觉 AK/SK：请配置 VOLC_ACCESS_KEY_ID 与 VOLC_SECRET_ACCESS_KEY，Ark API Key 不能直接调用该 CV 接口。"
        )
    image_candidates = [(i, ref, url) for i, ref, url in resolved_images if str(url or "").startswith(("http://", "https://"))]
    audio_candidates = [(i, ref, url) for i, ref, url in resolved_audios if str(url or "").startswith(("http://", "https://"))]
    if not image_candidates:
        raise HTTPException(
            400,
            "OmniHuman 数字人需要公网可访问的角色图 URL。请配置 PUBLIC_BASE_URL，或上传可被火山读取的图片 URL；本地 dataURL/localhost 不能直接提交。"
        )
    if not audio_candidates:
        raise HTTPException(
            400,
            "OmniHuman 数字人需要公网可访问的口播音频 URL。请配置 PUBLIC_BASE_URL，或上传可被火山读取的 mp3/wav URL；本地 dataURL/localhost 不能直接提交。"
        )
    body = {
        "req_key": DIGITAL_HUMAN_REQ_KEY,
        "image_url": image_candidates[0][2],
        "audio_url": audio_candidates[0][2],
        "seed": -1,
        "prompt": str(req.prompt or "角色自然口播，动作和表情自然。").strip()[:300],
        "output_resolution": 1080 if DIGITAL_HUMAN_OUTPUT_RESOLUTION == 1080 else 720,
        "pe_fast_mode": bool(DIGITAL_HUMAN_PE_FAST_MODE),
    }
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    url = _digital_human_url("CVSubmitTask")
    headers = _volc_signed_headers("POST", url, raw)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=8.0), trust_env=False) as client:
            r = await _queued_video_post(client, url, content=raw, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 OmniHuman 智能视觉接口：{exc.__class__.__name__} {exc}")
    try:
        data = r.json()
    except Exception:
        data = {"message": r.text[:1000]}
    if r.status_code >= 400:
        raise HTTPException(r.status_code, _digital_human_transient_detail(data, r.status_code) or "OmniHuman 提交失败")
    code = data.get("code")
    if code not in (None, 10000, "10000"):
        raise HTTPException(502, _digital_human_transient_detail(data, 502) or f"OmniHuman 提交失败：code={code}")
    task_id = _find_provider_ref(data)
    if not task_id:
        raise HTTPException(502, {"detail": "OmniHuman 已返回结果，但没有任务 ID；请检查接口返回结构。", "raw": data})
    return {"ok": True, "provider": "jimeng-omnihuman", "providerRef": f"omnihuman:{task_id}", "raw": data}


async def _digital_human_poll(task_id: str):
    if not _digital_human_configured():
        raise HTTPException(
            500,
            "OmniHuman 数字人未配置火山智能视觉 AK/SK：请配置 VOLC_ACCESS_KEY_ID 与 VOLC_SECRET_ACCESS_KEY。"
        )
    body = {"req_key": DIGITAL_HUMAN_REQ_KEY, "task_id": _digital_human_task_id(task_id)}
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    url = _digital_human_url("CVGetResult")
    headers = _volc_signed_headers("POST", url, raw)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=8.0), trust_env=False) as client:
            r = await client.post(url, content=raw, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 OmniHuman 智能视觉接口：{exc.__class__.__name__} {exc}")
    try:
        data = r.json()
    except Exception:
        data = {"message": r.text[:1000]}
    if r.status_code >= 400:
        raise HTTPException(r.status_code, _http_detail(data) or "OmniHuman 轮询失败")
    code = data.get("code")
    if code not in (None, 10000, "10000"):
        return {
            "ok": True,
            "status": "failed",
            "progress": 0,
            "output": None,
            "error": _http_detail(data) or f"OmniHuman 轮询失败：code={code}",
            "raw": data,
        }
    status = _cv_status(data)
    video_url = _find_video_url(data)
    output = None
    error = _cv_error(data) if status == "failed" else None
    if status == "succeeded" and video_url:
        stable_url, cache_error = await _cache_generated_video_output(video_url, "omnihuman")
        if stable_url:
            output = {"url": stable_url, "label": "OmniHuman 数字人片段已生成"}
        else:
            status = "failed"
            error = cache_error or "OmniHuman 已生成视频，但服务器未能缓存成片，请重试该段。"
    elif video_url:
        stable_url, _ = await _cache_generated_video_output(video_url, "omnihuman")
        if stable_url:
            output = {"url": stable_url, "label": "OmniHuman 数字人片段已生成"}
    return {
        "ok": True,
        "status": status,
        "progress": _video_progress(data, status),
        "output": output,
        "error": error,
        "raw": data,
    }


def _find_provider_ref(data: dict) -> str:
    if not isinstance(data, dict):
        return ""
    d1 = data.get("data") if isinstance(data.get("data"), dict) else {}
    d2 = d1.get("data") if isinstance(d1.get("data"), dict) else {}
    for obj in (data, d1, d2):
        for key in ("id", "task_id", "taskId", "taskID", "generation_id", "generationId"):
            value = obj.get(key)
            if value:
                return str(value)
    return ""


@app.get("/api/video/config")
def video_config(_me=Depends(require_creator)):
    reachable, detail = _resolve_base(SEEDANCE_BASE_URL)
    dh_reachable, dh_detail = _resolve_base(DIGITAL_HUMAN_BASE_URL)
    return {
        "ok": True,
        "provider": _video_provider_name(),
        "configured": bool(SEEDANCE_API_KEY),
        "reachable": reachable,
        "detail": detail,
        "model": SEEDANCE_MODEL,
        "digitalHumanModel": DIGITAL_HUMAN_MODEL,
        "digitalHumanConfigured": _digital_human_configured(),
        "digitalHumanReachable": dh_reachable,
        "digitalHumanDetail": dh_detail,
        "digitalHumanReqKey": DIGITAL_HUMAN_REQ_KEY,
        "payloadMode": _video_payload_mode(),
        "baseUrl": _public_base(SEEDANCE_BASE_URL),
        "digitalHumanBaseUrl": _public_base(DIGITAL_HUMAN_BASE_URL),
        "publicBaseConfigured": bool(PUBLIC_BASE_URL),
    }


@app.get("/api/video/ref/{rid}")
def video_ref(rid: str):
    item = VIDEO_REFS.get(rid)
    if not item:
        raise HTTPException(404, "reference image not found")
    mime, data, _ = item
    return Response(content=data, media_type=mime, headers={"Cache-Control": "no-store"})


@app.post("/api/video/submit")
async def video_submit(req: VideoSubmitReq, _me=Depends(require_creator)):
    is_digital_human = _is_digital_human_request(req)
    if not SEEDANCE_API_KEY and not is_digital_human:
        raise HTTPException(500, "服务器未配置 SEEDANCE_API_KEY")
    resolved_images = []
    resolved_videos = []
    resolved_audios = []
    ignored_local_videos = []
    ignored_local_audios = []
    unresolved_local_images = []
    for i, ref in enumerate((req.refs or [])[:15]):
        kind = _ref_kind(ref)
        url = _ref_url(ref)
        if url and kind == "audio" and url.startswith("data:"):
            ignored_local_audios.append(ref.name or f"音频{i + 1}")
        elif url and kind == "audio":
            resolved_audios.append((i, ref, url))
        elif url and kind == "video" and url.startswith("data:"):
            ignored_local_videos.append(ref.name or f"视频{i + 1}")
        elif url and kind == "video":
            resolved_videos.append((i, ref, url))
        elif url and kind == "image":
            resolved_images.append((i, ref, url))
        elif ref.dataUrl and kind == "audio":
            ignored_local_audios.append(ref.name or f"音频{i + 1}")
        elif ref.dataUrl and kind == "video":
            ignored_local_videos.append(ref.name or f"视频{i + 1}")
        elif kind == "video" and (ref.url or "").startswith(("http://localhost", "https://localhost", "http://127.0.0.1", "https://127.0.0.1")):
            ignored_local_videos.append(ref.name or f"视频{i + 1}")
        elif ref.dataUrl or (ref.url or "").startswith(("http://localhost", "https://localhost", "http://127.0.0.1", "https://127.0.0.1")):
            unresolved_local_images.append(ref.name or f"图{i + 1}")
    if is_digital_human:
        return await _digital_human_submit(req, resolved_images, resolved_audios)
    resolved_images = resolved_images[:9]
    resolved_videos = resolved_videos[:3]
    resolved_audios = resolved_audios[:3]
    if unresolved_local_images:
        # 本地调试时 localhost/dataURL 参考图无法被 Seedance 上游读取。图片参考降级为纯文本生成，
        # 避免卡死创作；音频参考仍需真实可访问 URL，因为它会影响生成声音。
        pass
    ref_parts = []
    if resolved_images:
        ref_parts.append(f"请参考{'、'.join(f'[图{i + 1}]' for i, _, _ in resolved_images)}，并保持主体、界面和画面结构信息一致。")
    if resolved_videos:
        ref_parts.append(f"请参考{'、'.join(f'[视频{i + 1}]' for i, _, _ in resolved_videos)}的镜头节奏、运动方式、构图层次和转场节奏；画面主题仍以文本提示词为准。")
    if unresolved_local_images:
        ref_parts.append("部分本地参考图当前无法被上游读取，本次按文本提示词生成；部署到有 PUBLIC_BASE_URL 的服务器后可自动携带参考图。")
    if resolved_audios:
        ref_parts.append(f"请参考{'、'.join(f'[音频{i + 1}]' for i, _, _ in resolved_audios)}的声线、音色、语气和语速生成视频口播；口播内容以文本提示词为准，不生成字幕。")
    if ignored_local_videos:
        raise HTTPException(
            400,
            "Seedance 视频参考没有传给上游：当前视频是本地文件/dataURL，上游无法读取。"
            "请配置 PUBLIC_BASE_URL 为 Seedance 可访问的 http 地址，或把 mp4 上传到可访问 URL 后再作为视频参考。"
        )
    if ignored_local_audios:
        raise HTTPException(
            400,
            "Seedance 声线参考音频没有传给上游：当前音频是本地文件/dataURL，上游无法读取。"
            "请配置 PUBLIC_BASE_URL 为 Seedance 可访问的 http 地址，或把 mp3 上传到可访问 URL 后再作为声线参考。"
        )
    ref_hint = ("\n".join(ref_parts) + "\n") if ref_parts else ""
    content = [{"type": "text", "text": ref_hint + req.prompt.strip()}]
    for i, ref, url in resolved_images:
        content.append({"type": "image_url", "image_url": {"url": url}, "role": _ref_role(ref, i)})
    for i, ref, url in resolved_videos:
        content.append({"type": "video_url", "video_url": {"url": url}, "role": "reference_video"})
    for i, ref, url in resolved_audios:
        content.append({"type": "audio_url", "audio_url": {"url": url}, "role": "reference_audio"})
    payload = _video_payload(req, content)
    headers = {
        "Authorization": f"Bearer {SEEDANCE_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=8.0), trust_env=False) as client:
            r = await _queued_video_post(client, _video_submit_url(), json=payload, headers=headers)
            if r.status_code >= 400 and resolved_images:
                try:
                    err_text = json.dumps(r.json(), ensure_ascii=False)
                except Exception:
                    err_text = r.text[:1200]
                low = err_text.lower()
                if "image_url" in low and ("timeout while fetching" in low or "fetching resource" in low or "not valid" in low):
                    fallback_content = [{
                        "type": "text",
                        "text": (
                            "参考图当前无法被 Seedance 上游读取，本次自动降级为纯文本生成；"
                            "请按提示词里的文字描述完成画面，不要因为参考图不可读而失败。\n"
                            + req.prompt.strip()
                        ),
                    }]
                    fallback_payload = _video_payload(req, fallback_content)
                    r = await _queued_video_post(client, _video_submit_url(), json=fallback_payload, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接 Seedance（{SEEDANCE_BASE_URL}）：{exc.__class__.__name__} {exc}。请确认 SEEDANCE_BASE_URL 可达（内网地址需在内网/VPN）。")
    if r.status_code >= 400:
        try:
            error_data = r.json()
            detail = _normalize_provider_error(
                _readable_error(error_data.get("error")) or
                _http_detail(error_data.get("detail")) or
                _http_detail(error_data) or
                r.text[:800]
            )
        except Exception:
            detail = _normalize_provider_error(r.text[:800])
        raise HTTPException(r.status_code, detail)
    data = r.json()
    provider_ref = _find_provider_ref(data)
    if not provider_ref:
        raise HTTPException(502, {"detail": "Seedance 已返回结果，但没有任务 ID；请检查模型/接口返回结构。", "raw": data})
    return {"ok": True, "provider": _video_provider_name(), "providerRef": provider_ref, "raw": data}


@app.get("/api/video/poll/{task_id}")
async def video_poll(task_id: str, _me=Depends(require_creator)):
    if _is_digital_human_task(task_id):
        return await _digital_human_poll(task_id)
    if not SEEDANCE_API_KEY:
        raise HTTPException(500, "服务器未配置 SEEDANCE_API_KEY")
    headers = {"Authorization": f"Bearer {SEEDANCE_API_KEY}", "Accept": "application/json", "Accept-Encoding": "identity"}
    async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
        r = await client.get(_video_poll_url(task_id), headers=headers)
    if r.status_code >= 400:
        try:
            error_data = r.json()
            detail = _normalize_provider_error(
                _readable_error(error_data.get("error")) or
                _http_detail(error_data.get("detail")) or
                _http_detail(error_data) or
                r.text[:800]
            )
        except Exception:
            detail = _normalize_provider_error(r.text[:800])
        raise HTTPException(r.status_code, detail)
    data = r.json()
    status = _video_status(data)
    video_url = _find_video_url(data)
    output = None
    error = _video_error(data) if status == "failed" else None
    if status == "succeeded" and video_url:
        stable_url, cache_error = await _cache_generated_video_output(video_url, "seedance")
        if stable_url:
            output = {"url": stable_url, "label": "Seedance 片段已生成"}
        else:
            status = "failed"
            error = cache_error or "Seedance 已生成视频，但服务器未能缓存成片，请重试该段。"
    elif video_url:
        stable_url, _ = await _cache_generated_video_output(video_url, "seedance")
        if stable_url:
            output = {"url": stable_url, "label": "Seedance 片段已生成"}
    return {
        "ok": True,
        "status": status,
        "progress": _video_progress(data, status),
        "output": output,
        "error": error,
        "raw": data,
    }


@app.post("/api/video/cancel/{task_id}")
async def video_cancel(task_id: str, _me=Depends(require_creator)):
    if _is_digital_human_task(task_id):
        return {"ok": True}
    if SEEDANCE_API_KEY:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            await client.delete(_video_poll_url(task_id),
                                headers={"Authorization": f"Bearer {SEEDANCE_API_KEY}"})
    return {"ok": True}


def _proxy_ip_blocked(value: str) -> bool:
    try:
        address = ipaddress.ip_address(str(value or "").split("%", 1)[0])
    except ValueError:
        return True
    return not address.is_global


def _validate_proxy_target(url: str) -> str:
    target = str(url or "").strip()
    parsed = urlparse(target)
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if (
        parsed.scheme not in {"http", "https"}
        or not host
        or parsed.username
        or parsed.password
    ):
        raise HTTPException(400, "仅支持安全的 http/https 文件地址")
    if host == "localhost" or host.endswith((".localhost", ".local")):
        raise HTTPException(403, "禁止访问本机或内网文件地址")
    try:
        direct_ip = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        direct_ip = None
    if direct_ip is not None:
        if _proxy_ip_blocked(str(direct_ip)):
            raise HTTPException(403, "禁止访问私网、回环或链路本地地址")
        return target
    try:
        addresses = {
            item[4][0]
            for item in socket.getaddrinfo(
                host,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
            if item and len(item) > 4 and item[4]
        }
    except (OSError, socket.gaierror):
        raise HTTPException(400, "远端文件域名无法解析")
    if not addresses or any(_proxy_ip_blocked(address) for address in addresses):
        raise HTTPException(403, "禁止访问私网、回环或链路本地地址")
    return target


def _proxy_redirect_target(current_url: str, location: str) -> str:
    if not str(location or "").strip():
        raise HTTPException(502, "远端文件重定向缺少目标地址")
    return _validate_proxy_target(urljoin(current_url, location))


def _proxy_media_type(content_type: str, url: str = "") -> str:
    media = str(content_type or "").split(";", 1)[0].strip().lower()
    if (
        media.startswith(("video/", "audio/", "image/"))
        or media in {
            "application/octet-stream",
            "binary/octet-stream",
            "application/mp4",
            "application/vnd.apple.mpegurl",
            "application/x-mpegurl",
        }
    ):
        return media
    if not media:
        guessed = (mimetypes.guess_type(urlparse(url).path)[0] or "").lower()
        if guessed.startswith(("video/", "audio/", "image/")):
            return guessed
    raise HTTPException(415, "远端响应不是允许的图片、音频或视频文件")


async def _download_public_media(url: str) -> Tuple[bytes, str]:
    current = _validate_proxy_target(url)
    timeout = httpx.Timeout(PROXY_FILE_TIMEOUT, connect=min(12.0, PROXY_FILE_TIMEOUT))
    try:
        async with httpx.AsyncClient(
            timeout=timeout,
            trust_env=False,
            follow_redirects=False,
        ) as client:
            for redirect_count in range(PROXY_FILE_MAX_REDIRECTS + 1):
                async with client.stream(
                    "GET",
                    current,
                    headers={
                        "Accept": "video/*, audio/*, image/*, application/octet-stream",
                        "Accept-Encoding": "identity",
                    },
                ) as response:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        if redirect_count >= PROXY_FILE_MAX_REDIRECTS:
                            raise HTTPException(502, "远端文件重定向次数过多")
                        current = _proxy_redirect_target(
                            current,
                            response.headers.get("location", ""),
                        )
                        continue
                    if response.status_code >= 400:
                        raise HTTPException(
                            response.status_code,
                            "远端文件下载失败",
                        )
                    media = _proxy_media_type(
                        response.headers.get("content-type", ""),
                        current,
                    )
                    raw_length = response.headers.get("content-length", "")
                    if raw_length:
                        try:
                            if int(raw_length) > PROXY_FILE_MAX_BYTES:
                                raise HTTPException(413, "远端文件超过代理大小上限")
                        except ValueError:
                            pass
                    chunks = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > PROXY_FILE_MAX_BYTES:
                            raise HTTPException(413, "远端文件超过代理大小上限")
                        chunks.append(chunk)
                    return b"".join(chunks), media
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(
            502,
            f"远端文件下载失败：{exc.__class__.__name__}",
        )
    raise HTTPException(502, "远端文件下载失败")


@app.post("/api/proxy/file")
async def proxy_file(req: FileProxyReq, _me=Depends(require_creator)):
    """把远端生成结果转成同源下载，供前端打包 ZIP 使用。"""
    content, media = await _download_public_media(req.url)
    return Response(content=content, media_type=media)


@app.get("/api/video/composed/{name}")
def composed_file(name: str, request: Request):
    safe_name = Path(name).name
    path = COMPOSED_DIR / safe_name
    if not path.exists():
        raise HTTPException(404, "成片不存在")
    return ranged_file_response(request, path, media_type="video/mp4")


async def _write_video_source(client: httpx.AsyncClient, url: str, path: Path, label: str) -> bool:
    source = str(url or "").strip()
    if not source:
        return False
    local = _local_server_file_path(source)
    if local:
        if not local.exists() or local.stat().st_size <= 0:
            raise HTTPException(502, f"{label}不可读取")
        shutil.copyfile(local, path)
        return True
    if not source.startswith(("http://", "https://")):
        return False
    try:
        data = await _download_binary(client, source, label)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    path.write_bytes(data)
    return True


def _supported_video_source(url: str) -> bool:
    source = str(url or "").strip()
    return bool(source and (source.startswith(("http://", "https://", "/api/video/composed/", "/api/files/"))))


def _srt_time(value: float) -> str:
    ms = max(0, int(round(float(value or 0) * 1000)))
    hour, rest = divmod(ms, 3600000)
    minute, rest = divmod(rest, 60000)
    second, milli = divmod(rest, 1000)
    return f"{hour:02d}:{minute:02d}:{second:02d},{milli:03d}"


def _write_compose_srt(path: Path, subtitles: List[ComposeSubtitle]) -> bool:
    rows = []
    last_end = -0.05
    for sub in subtitles or []:
        text = str(sub.text or "").strip().replace("\r", "").replace("\n", " ")
        if not text:
            continue
        start = max(last_end + 0.05, float(sub.start or 0))
        end = max(start + 0.35, float(sub.end or 0))
        rows.append(f"{len(rows) + 1}\n{_srt_time(start)} --> {_srt_time(end)}\n{text}\n")
        last_end = end
    if not rows:
        return False
    path.write_text("\n".join(rows), "utf-8")
    return True


def _compose_subtitle_font() -> Tuple[str, str]:
    """选取真实包含中文字符的字体，避免服务器烧录字幕变成方框。"""
    configured_file = Path(os.getenv("SUBTITLE_FONT_FILE", "").strip()).expanduser()
    configured_name = os.getenv("SUBTITLE_FONT_NAME", "").strip()
    if configured_file.is_file():
        return configured_name or "Noto Sans CJK SC", str(configured_file.parent)
    candidates = [
        ("Noto Sans CJK SC", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        ("Noto Sans CJK SC", "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf"),
        ("Source Han Sans SC", "/usr/share/fonts/opentype/adobe-source-han-sans/SourceHanSansSC-Regular.otf"),
        ("WenQuanYi Zen Hei", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
        ("PingFang SC", "/System/Library/Fonts/PingFang.ttc"),
        ("Heiti SC", "/System/Library/Fonts/STHeiti Medium.ttc"),
    ]
    for family, font_path in candidates:
        path = Path(font_path)
        if path.is_file():
            return family, str(path.parent)
    fc_match = shutil.which("fc-match")
    if fc_match:
        for family in ("Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei"):
            run = subprocess.run(
                [fc_match, "-f", "%{family}|%{file}", family],
                capture_output=True,
                text=True,
                timeout=10,
            )
            found_family, _, found_file = (run.stdout or "").strip().partition("|")
            if any(mark in found_family for mark in ("Noto Sans CJK", "Source Han Sans", "WenQuanYi")) and Path(found_file).is_file():
                return found_family.split(",", 1)[0], str(Path(found_file).parent)
    return configured_name or "Noto Sans CJK SC", ""


def _shift_subtitles_for_transitions(subtitles: List[ComposeSubtitle], clips: List[ComposeClip], transition: float) -> List[ComposeSubtitle]:
    """Keep captions aligned after xfade shortens every clip boundary."""
    if transition <= 0 or len(clips) < 2:
        return subtitles
    boundaries = []
    cursor = 0.0
    for clip in clips[:-1]:
        cursor += max(0.5, float(clip.dur or 0))
        boundaries.append(cursor)
    shifted = []
    for sub in subtitles or []:
        start = float(sub.start or 0)
        end = float(sub.end or 0)
        passed_start = sum(1 for boundary in boundaries if start >= boundary - 0.02)
        passed_end = sum(1 for boundary in boundaries if end > boundary + 0.02)
        shifted.append(ComposeSubtitle(
            start=max(0.0, start - passed_start * transition),
            end=max(0.0, end - passed_end * transition),
            text=sub.text,
        ))
    return shifted


def _compose_clip_preprocess_command(
    ffmpeg: str,
    input_path: Path,
    output_path: Path,
    clip: ComposeClip,
) -> List[str]:
    trim = max(0.0, float(clip.trimIn or 0))
    duration = max(0.0, float(clip.dur or 0))
    command = [ffmpeg, "-y", "-i", str(input_path)]
    if trim > 0:
        command += ["-ss", f"{trim:.3f}"]
    if duration > 0:
        command += ["-t", f"{duration:.3f}"]
    command += [
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-ar", "48000", "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart", str(output_path),
    ]
    return command


def _compose_with_xfade(ffmpeg: str, files: List[Path], clips: List[ComposeClip], output: Path, transition: float) -> bool:
    """Compose same-format digital-human clips with a short video/audio dissolve."""
    if transition <= 0 or len(files) < 2:
        return False
    transition = max(0.12, min(0.6, transition))
    command = [ffmpeg, "-y"]
    for path in files:
        command += ["-i", str(path)]
    filters = []
    durations = [max(0.5, float(clip.dur or 0)) for clip in clips]
    for index in range(len(files)):
        filters.append(f"[{index}:v]settb=AVTB,fps=30,format=yuv420p[v{index}]")
        filters.append(f"[{index}:a]aresample=async=1:first_pts=0[a{index}]")
    video_label = "v0"
    audio_label = "a0"
    elapsed = durations[0]
    for index in range(1, len(files)):
        video_out = f"vx{index}"
        audio_out = f"ax{index}"
        offset = max(0.1, elapsed - transition)
        filters.append(f"[{video_label}][v{index}]xfade=transition=fade:duration={transition:.3f}:offset={offset:.3f}[{video_out}]")
        filters.append(f"[{audio_label}][a{index}]acrossfade=d={transition:.3f}:c1=tri:c2=tri[{audio_out}]")
        video_label = video_out
        audio_label = audio_out
        elapsed += durations[index] - transition
    command += [
        "-filter_complex", ";".join(filters),
        "-map", f"[{video_label}]", "-map", f"[{audio_label}]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-t", f"{elapsed:.3f}", "-movflags", "+faststart", str(output)
    ]
    run = subprocess.run(command, capture_output=True, text=True, timeout=1200)
    return run.returncode == 0 and output.exists() and output.stat().st_size > 0


def _media_has_audio(ffmpeg: str, path: Path) -> bool:
    """Return whether a rendered base video has an audio stream.

    Digital-human clips already contain the real narration.  The compose step
    must detect that stream before adding BGM instead of replacing it.
    """
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        sibling = Path(ffmpeg).with_name("ffprobe")
        ffprobe = str(sibling) if sibling.is_file() else ""
    if ffprobe:
        run = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if run.returncode == 0:
            return bool((run.stdout or "").strip())
    run = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)], capture_output=True, text=True, timeout=30)
    return bool(re.search(r"Stream\s+#.*?Audio:", run.stderr or ""))


def _compose_audio_command(
    ffmpeg: str,
    base_path: Path,
    mixed_path: Path,
    total_dur: float,
    narr_path: Path,
    bgm_path: Path,
    *,
    has_base_audio: bool,
    has_narr: bool,
    has_bgm: bool,
    preserve_clip_audio: bool,
    narration_volume: float,
    bgm_volume: float,
) -> List[str]:
    """Build a deterministic mix graph while keeping the original clip voice.

    When `preserve_clip_audio` is true (digital human), the base video's audio
    is the narration source.  An external narration asset is only a fallback.
    BGM loops to the full video duration and never shortens the voice track.
    """
    command = [ffmpeg, "-y", "-i", str(base_path)]
    narration_index = None
    bgm_index = None
    if has_narr:
        narration_index = 1
        command += ["-i", str(narr_path)]
    if has_bgm:
        bgm_index = 1 + int(has_narr)
        command += ["-stream_loop", "-1", "-i", str(bgm_path)]

    if preserve_clip_audio and has_base_audio:
        voice_index = 0
    elif narration_index is not None:
        voice_index = narration_index
    elif has_base_audio:
        voice_index = 0
    else:
        voice_index = None

    if voice_index is not None and bgm_index is not None:
        command += [
            "-filter_complex",
            f"[{voice_index}:a]volume={narration_volume}[voice];"
            f"[{bgm_index}:a]volume={bgm_volume}[music];"
            "[voice][music]amix=inputs=2:duration=longest:dropout_transition=0,aresample=async=1:first_pts=0[a]",
            "-map", "0:v:0", "-map", "[a]",
        ]
    elif voice_index is not None:
        command += ["-map", "0:v:0", "-map", f"{voice_index}:a:0", "-filter:a", f"volume={narration_volume}"]
    elif bgm_index is not None:
        command += ["-map", "0:v:0", "-map", f"{bgm_index}:a:0", "-filter:a", f"volume={bgm_volume}"]
    else:
        command += ["-map", "0:v:0"]
    command += [
        "-c:v", "copy", "-c:a", "aac", "-t", f"{total_dur:.3f}",
        "-movflags", "+faststart", str(mixed_path),
    ]
    return command


@app.post("/api/video/compose")
async def video_compose(req: ComposeReq, _me=Depends(require_creator)):
    """把时间轴上的 Seedance 片段拼成一个同源 mp4。
    本地/服务器都需要安装 ffmpeg；支持把口播与 BGM 混进成片。"""
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        raise HTTPException(501, "本机未安装 ffmpeg，无法合成成片。服务器部署时请安装 ffmpeg 后再使用 /api/video/compose。")
    clips = [c for c in (req.clips or []) if _supported_video_source(c.url)]
    if not clips:
        raise HTTPException(400, "没有可合成的视频片段 URL")
    transition = max(0.0, min(0.6, float(req.transitionDuration or 0))) if len(clips) > 1 else 0.0
    raw_total_dur = sum(float(c.dur or 0) for c in clips) or (len(clips) * 15)
    total_dur = max(0.5, raw_total_dur - transition * max(0, len(clips) - 1))
    COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
    out_name = f"{time.time_ns()}_{uuid.uuid4().hex[:6]}_{hashlib.sha1((req.title or 'final').encode('utf-8')).hexdigest()[:8]}.mp4"
    out_path = COMPOSED_DIR / out_name
    with tempfile.TemporaryDirectory() as td:
        tdir = Path(td)
        files = []
        narr_path = tdir / "narration.mp3"
        bgm_path = tdir / "bgm.mp3"
        async with httpx.AsyncClient(**_httpx_async_client_kwargs(timeout=httpx.Timeout(240.0, connect=12.0), trust_env=False, follow_redirects=True)) as client:
            for i, c in enumerate(clips):
                raw_fp = tdir / f"clip_raw_{i:03d}.mp4"
                await _write_video_source(client, c.url, raw_fp, f"下载片段失败：{c.name or i + 1}")
                fp = raw_fp
                if float(c.trimIn or 0) > 0 or float(c.dur or 0) > 0:
                    fp = tdir / f"clip_{i:03d}.mp4"
                    preprocess = subprocess.run(
                        _compose_clip_preprocess_command(ffmpeg, raw_fp, fp, c),
                        capture_output=True,
                        text=True,
                        timeout=900,
                    )
                    if preprocess.returncode != 0 or not fp.exists() or fp.stat().st_size <= 0:
                        raise HTTPException(502, "ffmpeg 裁切片段失败：" + (preprocess.stderr or preprocess.stdout)[-800:])
                files.append(fp)
            if req.narrationDataUrl:
                _write_data_url(narr_path, req.narrationDataUrl)
            elif req.narrationUrl:
                await _write_video_source(client, req.narrationUrl, narr_path, "下载口播音频失败")
            if req.bgmDataUrl:
                _write_data_url(bgm_path, req.bgmDataUrl)
            elif req.bgmUrl:
                await _write_video_source(client, req.bgmUrl, bgm_path, "下载 BGM 失败")
        concat = tdir / "concat.txt"
        lines = []
        for f in files:
            escaped = str(f).replace("'", "'\\''")
            lines.append(f"file '{escaped}'")
        concat.write_text("\n".join(lines), "utf-8")
        base_path = tdir / "base.mp4"
        mixed_path = tdir / "mixed.mp4"
        srt_path = tdir / "captions.srt"
        transitioned = _compose_with_xfade(ffmpeg, files, clips, base_path, transition)
        if not transitioned:
            total_dur = max(0.5, raw_total_dur)
            cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(base_path)]
            run = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
            if run.returncode != 0:
                cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(base_path)]
                run = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
            if run.returncode != 0 or not base_path.exists():
                raise HTTPException(502, "ffmpeg 合成失败：" + (run.stderr or run.stdout)[-800:])
        has_narr = narr_path.exists() and narr_path.stat().st_size > 0
        has_bgm = bgm_path.exists() and bgm_path.stat().st_size > 0
        has_base_audio = _media_has_audio(ffmpeg, base_path)
        if not has_narr and not has_bgm:
            shutil.copyfile(base_path, mixed_path)
        else:
            vol = max(0.05, min(0.6, float(req.bgmVolume or 0.25)))
            narration_vol = max(0.0, min(1.0, float(req.narrationVolume if req.narrationVolume is not None else 1.0)))
            audio_cmd = _compose_audio_command(
                ffmpeg, base_path, mixed_path, total_dur, narr_path, bgm_path,
                has_base_audio=has_base_audio,
                has_narr=has_narr,
                has_bgm=has_bgm,
                preserve_clip_audio=bool(req.preserveClipAudio),
                narration_volume=narration_vol,
                bgm_volume=vol,
            )
            run = subprocess.run(audio_cmd, capture_output=True, text=True, timeout=900)
            if run.returncode != 0 or not mixed_path.exists():
                raise HTTPException(502, "ffmpeg 混音失败：" + (run.stderr or run.stdout)[-800:])
        compose_subtitles = _shift_subtitles_for_transitions(req.subtitles, clips, transition if transitioned else 0.0)
        if _write_compose_srt(srt_path, compose_subtitles):
            srt_filter = str(srt_path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
            style = req.subtitleStyle
            ass_size = max(7.0, min(16.0, float(style.size or 11) * 0.82))
            ass_outline = max(0.0, min(2.0, float(style.stroke or 0) * 0.75))
            ass_margin = max(18, min(120, int(float(style.bottom or 22) * 2.88)))
            font_name, fonts_dir = _compose_subtitle_font()
            force_style = (
                f"FontName={font_name},FontSize={ass_size:.1f},Outline={ass_outline:.1f},Shadow=0,"
                f"Alignment=2,MarginV={ass_margin}"
            )
            fonts_arg = ""
            if fonts_dir:
                escaped_fonts_dir = fonts_dir.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
                fonts_arg = f":fontsdir='{escaped_fonts_dir}'"
            subtitle_cmd = [
                ffmpeg, "-y", "-i", str(mixed_path),
                "-vf", f"subtitles='{srt_filter}':charenc=UTF-8{fonts_arg}:force_style='{force_style}'",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", str(out_path)
            ]
            run = subprocess.run(subtitle_cmd, capture_output=True, text=True, timeout=900)
            if run.returncode != 0 or not out_path.exists():
                raise HTTPException(502, "ffmpeg 字幕烧录失败：" + (run.stderr or run.stdout)[-800:])
        else:
            shutil.copyfile(mixed_path, out_path)
    return {"ok": True, "url": f"/api/video/composed/{out_name}", "name": out_name}


# ---------- TTS 代理：MiniMax ----------
class TtsReq(BaseModel):
    text: str
    voiceId: str = ""
    speed: float = MINIMAX_TTS_SPEED
    vol: float = 1
    pitch: float = 0
    languageBoost: str = "auto"


class VoiceDesignReq(BaseModel):
    prompt: str = ""
    description: str = ""
    previewText: str = ""
    name: str = ""


def _known_voice_name(voice_id: str) -> str:
    vid = str(voice_id or "").strip()
    if not vid:
        return ""
    for item in MINIMAX_VOICE_PRESETS:
        if item.get("voiceId") == vid:
            return item.get("name") or vid
    return ""


def _int_if_whole(value, default=0):
    try:
        n = float(value)
        return int(n) if n.is_integer() else n
    except Exception:
        return default


async def _minimax_tts_request(payload: dict):
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=8.0), trust_env=False) as client:
        return await client.post(
            f"{MINIMAX_BASE_URL}/v1/t2a_v2",
            params=({"GroupId": MINIMAX_GROUP_ID} if MINIMAX_GROUP_ID else None),
            json=payload,
            headers={"Authorization": f"Bearer {MINIMAX_API_KEY}", "Content-Type": "application/json", "Accept": "application/json"}
        )


async def _minimax_voice_design_request(payload: dict):
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=8.0), trust_env=False) as client:
        return await client.post(
            f"{MINIMAX_BASE_URL}/v1/voice_design",
            params=({"GroupId": MINIMAX_GROUP_ID} if MINIMAX_GROUP_ID else None),
            json=payload,
            headers={"Authorization": f"Bearer {MINIMAX_API_KEY}", "Content-Type": "application/json", "Accept": "application/json"}
        )


def _minimax_connect_error(exc: Exception) -> str:
    return (
        "无法连接 Minimax TTS endpoint（%s）：%s %s。"
        "这是服务器到上游的网络/域名/代理问题，不是 voice_id 无效；"
        "如果部署在 BCC，请改用可访问的内网 Minimax 网关或配置可用代理。"
    ) % (_public_base(MINIMAX_BASE_URL), exc.__class__.__name__, exc)


def _normalize_minimax_tts_error(msg: str) -> str:
    text = str(msg or "")
    low = text.lower()
    if (
        "insufficient balance" in low
        or "balance insufficient" in low
        or "quota" in low
        or "credit" in low
        or "余额不足" in text
        or "额度不足" in text
        or "账户余额" in text
    ):
        return "Minimax TTS 上游返回余额或额度不足，请在服务器私密环境中更换可用 Key 或充值后重试。"
    return text


def _tts_payload(text: str, voice_id: str, speed=MINIMAX_TTS_SPEED, vol=1, pitch=0, language_boost="auto"):
    try:
        safe_vol = max(0.1, min(10.0, float(vol if vol is not None else 1)))
    except Exception:
        safe_vol = 1
    return {
        "model": MINIMAX_TTS_MODEL,
        "text": (text or "")[:9999],
        "stream": False,
        "language_boost": language_boost or "auto",
        "output_format": "hex",
        "voice_setting": {
            "voice_id": voice_id,
            "speed": _int_if_whole(speed, MINIMAX_TTS_SPEED),
            "vol": _int_if_whole(safe_vol, 1),
            "pitch": _int_if_whole(pitch, 0),
        },
        "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1},
    }


def _audio_data_url_from_minimax(data: dict) -> str:
    payload = data.get("data") if isinstance(data.get("data"), dict) else {}
    audio = (
        payload.get("audio") or payload.get("trial_audio") or
        data.get("audio") or data.get("trial_audio") or
        ""
    )
    if not audio:
        return ""
    fmt = ((data.get("extra_info") or {}).get("audio_format") or "mp3")
    if audio.startswith("data:audio/"):
        return audio
    try:
        raw = bytes.fromhex(audio)
        encoded = base64.b64encode(raw).decode("ascii")
    except ValueError:
        encoded = audio
    return f"data:audio/{fmt};base64,{encoded}"


def _minimax_voice_design_id(data: dict) -> str:
    payload = data.get("data") if isinstance(data.get("data"), dict) else {}
    return str(
        data.get("voice_id") or data.get("voiceId") or
        payload.get("voice_id") or payload.get("voiceId") or
        ""
    ).strip()


def _looks_like_voice_error(message: str) -> bool:
    msg = str(message or "").lower()
    return (
        "voice id" in msg or
        "voice_id" in msg or
        ("voice" in msg and ("exist" in msg or "invalid" in msg or "not found" in msg)) or
        "声线" in msg or
        "音色" in msg or
        "不存在" in msg
    )


def require_tts_creator(authorization: str = Header(default="")):
    """TTS 会消耗平台额度，只允许已登录的管理员或创作成员调用。"""
    try:
        return require_creator(authorization)
    except HTTPException as exc:
        if exc.status_code == 403:
            raise HTTPException(403, "当前账号不能使用语音生成")
        raise


@app.get("/api/tts/config")
def tts_config(_me=Depends(require_tts_creator)):
    reachable, detail = _resolve_base(MINIMAX_BASE_URL)
    return {
        "ok": True,
        "provider": "minimax",
        "configured": bool(MINIMAX_API_KEY),
        "model": MINIMAX_TTS_MODEL,
        "voiceId": MINIMAX_VOICE_ID,
        "voices": MINIMAX_VOICE_PRESETS,
        "baseUrl": _public_base(MINIMAX_BASE_URL),
        "groupIdConfigured": bool(MINIMAX_GROUP_ID),
        "reachable": reachable if MINIMAX_API_KEY else False,
        "detail": detail,
    }


@app.post("/api/tts/test")
async def tts_test(_me=Depends(require_tts_creator)):
    if not MINIMAX_API_KEY:
        raise HTTPException(500, "服务器未配置 MINIMAX_API_KEY")
    if not MINIMAX_VOICE_ID:
        raise HTTPException(400, "服务器未配置默认 Minimax voice_id")
    try:
        r = await _minimax_tts_request(_tts_payload("测试", MINIMAX_VOICE_ID))
    except httpx.HTTPError as exc:
        raise HTTPException(502, _minimax_connect_error(exc))
    if r.status_code >= 400:
        try:
            err = r.json()
            detail = _http_detail(err.get("detail")) or _readable_error(err.get("base_resp")) or _http_detail(err) or r.text[:500]
        except Exception:
            detail = r.text[:500]
        detail = _normalize_minimax_tts_error(detail)
        if _looks_like_voice_error(detail):
            raise HTTPException(400, "默认 Minimax voice_id 无效或不存在：" + detail[:500])
        raise HTTPException(r.status_code, detail)
    data = r.json()
    base = data.get("base_resp") or {}
    if base.get("status_code", 0) != 0:
        msg = _normalize_minimax_tts_error(base.get("status_msg") or "Minimax TTS 测试失败")
        if _looks_like_voice_error(msg):
            raise HTTPException(400, "默认 Minimax voice_id 无效或不存在：" + msg[:500])
        raise HTTPException(502, msg)
    return {"ok": True, "provider": "minimax", "model": MINIMAX_TTS_MODEL, "voiceId": MINIMAX_VOICE_ID}


@app.get("/api/tts/voice/lookup")
async def tts_voice_lookup(
    voiceId: str = "",
    test: bool = True,
    _me=Depends(require_tts_creator),
):
    voice_id = (voiceId or "").strip()
    if not voice_id:
        raise HTTPException(400, "请填写 Minimax voice_id")
    known_name = _known_voice_name(voice_id)
    result = {
        "ok": True,
        "provider": "minimax",
        "configured": bool(MINIMAX_API_KEY),
        "model": MINIMAX_TTS_MODEL,
        "voiceId": voice_id,
        "known": bool(known_name),
        "name": known_name,
        "valid": None,
        "detail": ""
    }
    if not test:
        return result
    if not MINIMAX_API_KEY:
        result["detail"] = "服务器未配置 Minimax TTS，已完成本地识别，无法做上游有效性测试"
        return result
    try:
        r = await _minimax_tts_request(_tts_payload("声线测试", voice_id))
    except httpx.HTTPError as exc:
        result["detail"] = _minimax_connect_error(exc)
        return result
    if r.status_code >= 400:
        try:
            err = r.json()
            detail = _http_detail(err.get("detail")) or _readable_error(err.get("base_resp")) or _http_detail(err) or r.text[:500]
        except Exception:
            detail = r.text[:500]
        result["valid"] = False if _looks_like_voice_error(detail) else None
        result["detail"] = detail
        return result
    data = r.json()
    base = data.get("base_resp") or {}
    if base.get("status_code", 0) != 0:
        msg = _normalize_minimax_tts_error(base.get("status_msg") or "Minimax TTS 声线测试失败")
        result["valid"] = False if _looks_like_voice_error(msg) else None
        result["detail"] = msg
        return result
    result["valid"] = True
    result["durationMs"] = int((data.get("extra_info") or {}).get("audio_length") or 0)
    return result


@app.post("/api/tts/voice/design")
async def tts_voice_design(
    req: VoiceDesignReq,
    _me=Depends(require_tts_creator),
):
    if not MINIMAX_API_KEY:
        raise HTTPException(500, "服务器未配置 MINIMAX_API_KEY")
    prompt = (req.prompt or req.description or "").strip()
    if not prompt:
        raise HTTPException(400, "请填写音色设计描述")
    preview_text = (req.previewText or "这是一段用于试听新音色的中文口播。语气自然，节奏清楚，适合内容创作。").strip()
    payload = {
        "prompt": prompt[:1200],
        "preview_text": preview_text[:2000],
    }
    try:
        r = await _minimax_voice_design_request(payload)
    except httpx.HTTPError as exc:
        raise HTTPException(502, _minimax_connect_error(exc))
    try:
        data = r.json()
    except Exception:
        data = {}
    if r.status_code >= 400:
        detail = _http_detail(data.get("detail")) if data else ""
        detail = detail or _readable_error(data.get("base_resp")) or _http_detail(data) or r.text[:500]
        raise HTTPException(r.status_code, _normalize_minimax_tts_error(detail or "Minimax 音色设计失败"))
    base = data.get("base_resp") or {}
    if base.get("status_code", 0) != 0:
        raise HTTPException(502, _normalize_minimax_tts_error(base.get("status_msg") or "Minimax 音色设计失败"))
    voice_id = _minimax_voice_design_id(data)
    if not voice_id:
        raise HTTPException(502, {"detail": "Minimax 已返回结果，但没有 voice_id", "raw": data})
    audio_data_url = _audio_data_url_from_minimax(data)
    return {
        "ok": True,
        "provider": "minimax",
        "voiceId": voice_id,
        "name": (req.name or "").strip() or voice_id,
        "audioDataUrl": audio_data_url,
        "model": MINIMAX_TTS_MODEL,
        "traceId": data.get("trace_id") or "",
    }


@app.post("/api/tts/generate")
async def tts_generate(
    req: TtsReq,
    _me=Depends(require_tts_creator),
):
    if not MINIMAX_API_KEY:
        raise HTTPException(500, "服务器未配置 MINIMAX_API_KEY")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(400, "口播文本为空")
    voice_id = (req.voiceId or MINIMAX_VOICE_ID).strip()
    if not voice_id:
        raise HTTPException(400, "请填写 Minimax voice_id")
    def build_payload(vid: str):
        return _tts_payload(text, vid, req.speed, req.vol, req.pitch, req.languageBoost)
    payload = build_payload(voice_id)
    used_fallback_voice = False
    try:
        r = await _minimax_tts_request(payload)
    except httpx.HTTPError as exc:
        raise HTTPException(502, _minimax_connect_error(exc))
    if r.status_code >= 400:
        try:
            err = r.json()
            detail = _http_detail(err.get("detail")) or _readable_error(err.get("base_resp")) or _http_detail(err) or r.text[:500]
        except Exception:
            detail = r.text[:500]
        detail = _normalize_minimax_tts_error(detail)
        if voice_id != MINIMAX_VOICE_ID and _looks_like_voice_error(detail):
            payload = build_payload(MINIMAX_VOICE_ID)
            used_fallback_voice = True
            try:
                r = await _minimax_tts_request(payload)
            except httpx.HTTPError as exc:
                raise HTTPException(502, _minimax_connect_error(exc))
            if r.status_code >= 400:
                try:
                    err = r.json()
                    detail = _http_detail(err.get("detail")) or _readable_error(err.get("base_resp")) or _http_detail(err) or r.text[:500]
                except Exception:
                    detail = r.text[:500]
                raise HTTPException(r.status_code, _normalize_minimax_tts_error(detail))
            data = r.json()
            base = data.get("base_resp") or {}
            voice_id = MINIMAX_VOICE_ID
        else:
            raise HTTPException(r.status_code, detail)
    else:
        data = r.json()
        base = data.get("base_resp") or {}
    if base.get("status_code", 0) != 0:
        msg = _normalize_minimax_tts_error(base.get("status_msg") or "Minimax TTS 生成失败")
        if voice_id != MINIMAX_VOICE_ID and _looks_like_voice_error(msg):
            payload = build_payload(MINIMAX_VOICE_ID)
            used_fallback_voice = True
            try:
                r = await _minimax_tts_request(payload)
            except httpx.HTTPError as exc:
                raise HTTPException(502, _minimax_connect_error(exc))
            if r.status_code >= 400:
                try:
                    err = r.json()
                    detail = _http_detail(err.get("detail")) or _readable_error(err.get("base_resp")) or _http_detail(err) or r.text[:500]
                except Exception:
                    detail = r.text[:500]
                raise HTTPException(r.status_code, detail)
            data = r.json()
            base = data.get("base_resp") or {}
            voice_id = MINIMAX_VOICE_ID
        if base.get("status_code", 0) != 0:
            raise HTTPException(502, _normalize_minimax_tts_error(base.get("status_msg") or msg))
    audio_data_url = _audio_data_url_from_minimax(data)
    if not audio_data_url:
        raise HTTPException(502, {"detail": "Minimax 已返回结果，但没有 audio 字段", "raw": data})
    duration_ms = int((data.get("extra_info") or {}).get("audio_length") or 0)
    return {
        "ok": True,
        "audioDataUrl": audio_data_url,
        "voiceId": voice_id,
        "model": MINIMAX_TTS_MODEL,
        "durationMs": duration_ms,
        "duration": round(duration_ms / 1000, 1) if duration_ms else 0,
        "traceId": data.get("trace_id") or "",
        "fallbackVoice": used_fallback_voice,
    }


# ---------- 账号 ----------
class Account(BaseModel):
    name: str
    platform: str = "小红书"
    mode: str = "视频"
    subType: str = ""
    position: str = ""


@app.get("/api/accounts")
def list_accounts(response: Response, me=Depends(require_creator)):
    """旧客户端兼容读；权威数据已统一来自 /api/state 的文档库。"""
    response.headers["Deprecation"] = "true"
    response.headers["Link"] = '</api/state>; rel="successor-version"'
    return store.state_for(me["id"], me["role"], me.get("parentId")).get("accounts", [])


@app.post("/api/accounts")
def create_account(acc: Account, _me=Depends(require_creator)):
    raise HTTPException(410, "旧账号写入接口已停用，请使用 /api/db/accounts")


@app.delete("/api/accounts/{acc_id}")
def delete_account(acc_id: str, _me=Depends(require_creator)):
    raise HTTPException(410, "旧账号写入接口已停用，请使用 /api/db/accounts")


# ---------- 素材（供应商端下载的成片） ----------
class Asset(BaseModel):
    name: str
    accountId: str
    type: str = "视频"
    tags: List[str] = []
    url: Optional[str] = None      # 对象存储地址（BOS/OSS/S3）


@app.get("/api/assets")
def list_assets(
    platform: Optional[str] = None,
    tag: Optional[str] = None,
    _me=Depends(require_creator),
):
    items = load_db()["assets"]
    if platform:
        items = [x for x in items if x.get("platform") == platform]
    if tag:
        items = [x for x in items if tag in x.get("tags", [])]
    return items


@app.post("/api/assets")
def create_asset(asset: Asset, _me=Depends(require_creator)):
    db = load_db()
    acc = next((a for a in db["accounts"] if a["id"] == asset.accountId), None)
    item = {"id": uuid.uuid4().hex[:8], "createdAt": int(time.time()),
            "status": "未下载", "platform": acc["platform"] if acc else "",
            **asset.dict()}
    db["assets"].append(item)
    if acc:
        acc["monthlyDone"] = acc.get("monthlyDone", 0) + 1   # 月度进度+1
    save_db(db)
    return item


@app.post("/api/assets/{asset_id}/download")
def mark_downloaded(asset_id: str, _me=Depends(require_creator)):
    db = load_db()
    for x in db["assets"]:
        if x["id"] == asset_id:
            x["status"] = "已下载"
            save_db(db)
            return x
    raise HTTPException(404, "素材不存在")


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "llm_configured": bool(LLM_API_KEY),
        "llm_model": LLM_MODEL,
        "llm_endpoint": _mask_endpoint(LLM_ENDPOINT),
    }


def _deep_get(obj, *paths, default=None):
    for path in paths:
      cur = obj
      ok = True
      for key in path:
          if isinstance(cur, dict):
              cur = cur.get(key)
          elif isinstance(cur, list) and isinstance(key, int) and 0 <= key < len(cur):
              cur = cur[key]
          else:
              ok = False
              break
      if ok and cur not in (None, ""):
          return cur
    return default



# =========================================================
# 共享后端（Phase 1）：登录鉴权 + 全量快照 + 文档写穿透 + 成员管理
# =========================================================
class LoginReq(BaseModel):
    username: str
    pin: str


class PutReq(BaseModel):
    items: list


class CustomProjectReq(BaseModel):
    kind: str = "video"
    title: str = ""
    appVersion: str = ""
    projectState: dict = Field(default_factory=dict)
    outputIds: list = Field(default_factory=list)
    thumbnailId: str = ""
    status: str = "draft"
    publishedDeliveryId: str = ""


class CustomProjectPublishReq(BaseModel):
    deliveryId: str = ""
    delivery: dict = Field(default_factory=dict)
    assets: list = Field(default_factory=list)
    account: dict = Field(default_factory=dict)


class CustomCanvasAgentReq(BaseModel):
    brief: str = ""
    scene: str = "brand_kv"
    size: str = "1920x1080"
    references: List[dict] = Field(default_factory=list)
    images: List[str] = Field(default_factory=list)


class CustomCanvasGenerateReq(BaseModel):
    palette: str = "default"
    size: str = "1920x1080"
    count: int = Field(default=1, ge=1, le=10)
    startVariant: int = Field(default=1, ge=1, le=10000)
    labelPrefix: str = "Draft"
    prompt: str = ""
    negativePrompt: str = ""
    quality: str = "low"
    references: List[str] = Field(default_factory=list)
    mode: str = ""


class CustomCanvasProjectDraftReq(BaseModel):
    project: dict
    items: List[dict]
    messages: List[dict]
    viewport: Optional[dict] = None
    clientUpdatedAt: int = 0
    # 兼容首版客户端已发送的 true，以及带迁移来源说明的对象。
    migration: Any = False
    baseRevision: Optional[int] = None


class CustomCanvasEnhanceReq(BaseModel):
    image: str = ""
    size: str = "1920x1080"
    quality: str = "high"
    mode: str = ""


class CustomCanvasEditRegionReq(BaseModel):
    image: str = ""
    mask: str = ""
    instruction: str = ""
    width: int = Field(default=1920, ge=16, le=20000)
    height: int = Field(default=1080, ge=16, le=20000)


class CustomCanvasTransformReq(BaseModel):
    image: str = ""
    prompt: str = ""
    size: str = "1024x1024"
    fidelity: str = "high"
    quality: str = "low"


class MemberReq(BaseModel):
    name: str = ""
    username: str = ""
    pin: str = ""
    role: str = "editor"
    parentId: str = ""


class SupplierChildReq(BaseModel):
    name: str = ""
    username: str = ""
    pin: str = ""


class SupplierChildrenReq(BaseModel):
    items: list[SupplierChildReq] = []


class SupplierBindReq(BaseModel):
    accountIds: list = []


class SupplierActivityReq(BaseModel):
    action: str = ""
    accountId: str = ""
    assetId: str = ""
    detail: str = ""


class SupplierViewsReq(BaseModel):
    viewCount: int = 0


class SupplierHomepageReq(BaseModel):
    homepageUrl: str = ""


class SupplierPublishedLinkReq(BaseModel):
    url: str = ""
    note: str = ""
    title: str = ""
    rawText: str = ""


class DeliveryRemarkReq(BaseModel):
    text: str = ""


class MemberApplyReq(BaseModel):
    name: str = ""
    username: str = ""
    pin: str = ""
    role: str = "editor"
    message: str = ""


def _clean_role(role: str) -> str:
    if role == "supplier":
        return "supplier_parent"
    return role if role in {"admin", "editor", "supplier_parent", "supplier_child"} else "editor"


def require_member(authorization: str = Header(default="")):
    return _member_from_authorization(authorization)


def require_admin(me=Depends(require_member)):
    if me["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
    return me


def require_supplier_parent(me=Depends(require_member)):
    if me["role"] != "supplier_parent":
        raise HTTPException(403, "需要供应商管理权限")
    return me


@app.post("/api/auth/login")
def auth_login(req: LoginReq):
    row = store.get_member_by_username(req.username.strip())
    if not row or not store.verify_pin(req.pin.strip(), row[3]):
        raise HTTPException(401, "用户名或密码不正确")
    return {"token": store.make_token(row[0]), "member": store.member_public(row)}


@app.get("/api/auth/me")
def auth_me(me=Depends(require_member)):
    return me


@app.post("/api/member-requests")
def member_request_create(req: MemberApplyReq):
    name = req.name.strip()
    username = req.username.strip()
    pin = req.pin.strip()
    role = _clean_role(req.role)
    if role == "admin":
        role = "editor"
    if not name or not username or not pin:
        raise HTTPException(400, "姓名、用户名和密码都要填写")
    if store.get_member_by_username(username):
        raise HTTPException(409, "这个用户名已存在，请换一个")
    if store.username_has_pending_request(username):
        raise HTTPException(409, "这个用户名已有待审批申请，请等待管理员处理")
    row = store.add_member_request(name, username, pin, role, req.message.strip()[:240])
    return {"ok": True, "request": {
        "id": row[0],
        "name": row[1],
        "username": row[2],
        "role": row[4],
        "status": row[5],
        "createdAt": row[7],
    }}


@app.get("/api/state")
def api_state(response: Response, collections: str = "", me=Depends(require_member)):
    """返回当前成员可见快照，支持登录首屏按集合轻量拉取。"""
    response.headers["Cache-Control"] = "no-store"
    raw_names = [name.strip() for name in str(collections or "").split(",") if name.strip()]
    requested_names = list(dict.fromkeys(raw_names[:32]))
    requested_collections = [name for name in requested_names if name in store.COLLECTIONS]
    filtered = bool(raw_names)
    data = store.state_for(
        me["id"],
        me["role"],
        me.get("parentId"),
        requested_collections if filtered else None,
    )
    if not filtered or "members" in requested_names:
        if me["role"] == "admin":
            data["members"] = store.list_members()
        elif me["role"] == "supplier_parent":
            data["members"] = store.list_supplier_members()
        else:
            data["members"] = [me]
    response.headers["X-Xingzhen-State-Mode"] = "partial" if filtered else "full"
    return data


def _require_custom_creator(me):
    if me["role"] not in {"admin", "editor"}:
        raise HTTPException(403, "当前账号不能使用定制创作")
    return me


CUSTOM_CANVAS_PALETTES = {"tech", "business", "finance", "warm", "luxury", "default"}
CUSTOM_CANVAS_NEGATIVE = "blurry, low resolution, distorted proportions, messy layout, garbled text, misspelled words, watermark"


def _custom_canvas_parse_size(value: str, fallback: Tuple[int, int] = (1920, 1080)) -> Tuple[int, int]:
    match = re.match(r"^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})\s*$", str(value or ""), flags=re.I)
    if not match:
        return fallback
    width, height = int(match.group(1)), int(match.group(2))
    if not (16 <= width <= 20000 and 16 <= height <= 20000):
        return fallback
    return width, height


def _custom_canvas_ratio(value: str = "", width: int = 0, height: int = 0) -> str:
    if width <= 0 or height <= 0:
        width, height = _custom_canvas_parse_size(value)
    target = width / max(1, height)
    ratios = {
        "1:1": 1.0,
        "3:4": 3 / 4,
        "9:16": 9 / 16,
        "4:3": 4 / 3,
        "16:9": 16 / 9,
    }
    return min(ratios, key=lambda key: abs(ratios[key] - target))


def _custom_canvas_native_size(ratio: str) -> Tuple[int, int]:
    return _custom_canvas_parse_size(_image_size(_normalize_image_ratio(ratio)), (1024, 1024))


def _custom_canvas_data_url(value: str, label: str = "图片", max_chars: int = 24 * 1024 * 1024) -> str:
    data_url = str(value or "").strip()
    if not re.match(r"^data:image/(?:png|jpe?g|webp);base64,", data_url, flags=re.I):
        raise HTTPException(400, f"{label}格式不支持，请使用 PNG、JPG 或 WebP")
    if len(data_url) > max_chars:
        raise HTTPException(413, f"{label}过大，请压缩后重试")
    return data_url


def _custom_canvas_image_refs(values: List[str]) -> List[ImageRef]:
    refs = []
    total = 0
    for idx, value in enumerate((values or [])[:8], start=1):
        data_url = _custom_canvas_data_url(value, f"第 {idx} 张参考图")
        total += len(data_url)
        if total > 48 * 1024 * 1024:
            raise HTTPException(413, "参考图总大小过大，请减少数量或压缩后重试")
        refs.append(ImageRef(
            role="custom",
            name=f"canvas-reference-{idx}.png",
            mime=data_url[5:data_url.find(";")] if ";" in data_url else "image/png",
            dataUrl=data_url,
        ))
    return refs


def _custom_canvas_explicit_count(brief: str) -> int:
    zh = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
    text = str(brief or "")
    number = r"(\d+|[一两二三四五六七八九十])"
    verb = r"(?:请|同时|再)?(?:帮我|给我)?(?:生成|创作|制作|设计|做|出|来)"
    asset = r"(?:海报|图片|图像|设计|作品|成图|封面|主视觉)"
    patterns = (
        rf"{number}\s*(?:张|幅|版)\s*(?:{asset}|方案|方向)",
        rf"{verb}\s*{number}\s*(?:张|幅|版)(?:\s*{asset})?",
        rf"{verb}\s*{number}\s*(?:个\s*{asset}|款(?:\s*{asset})?|种(?:\s*(?:风格|方向|方案|设计|{asset}))?|个方向|个方案|方向|方案)",
        rf"{verb}\s*{number}\s*(?:个|种)?\s*(?:(?:不同|不一样|各异|差异化)(?:的)?\s*(?:风格|方向|版本|方案)|(?:风格|方向|版本|方案)\s*(?:不同|不一样|各异|差异化)(?:的)?)\s*(?:的)?\s*{asset}",
    )
    match = next((found for pattern in patterns if (found := re.search(pattern, text, flags=re.I))), None)
    if not match:
        return 1
    value = int(match.group(1)) if match.group(1).isdigit() else zh.get(match.group(1), 1)
    return max(1, min(10, value))


CUSTOM_CANVAS_SINGLE_IMAGE_GUARD = "单次只生成一张完整成图，禁止拼图、分屏或并排展示多个方案、版本或风格。"


def _custom_canvas_single_image_prompt(prompt: str, output_count: int) -> str:
    """Remove only parallel-output directives from one image request."""
    original = str(prompt or "").strip()
    if not original or output_count <= 1:
        return original
    cleaned = re.sub(
        r"((?:请|同时|再)?(?:帮我|给我)?(?:生成|创作|制作|设计|做|出|来))\s*"
        r"(?:\d+|[一两二三四五六七八九十])\s*(?:张|幅|版|个|种)?\s*"
        r"(?:(?:不同|不一样|各不相同|各异|差异化)(?:的)?\s*(?:风格|方向|版本|方案)|"
        r"(?:风格|方向|版本|方案)\s*(?:不同|不一样|各不相同|各异|差异化))(?:的)?\s*"
        r"(海报|图片|图像|设计|作品|成图|封面|主视觉)",
        r"\1一张\2",
        original,
        flags=re.I,
    )
    cleaned = re.sub(
        r"((?:请|同时|再)?(?:帮我|给我)?(?:生成|创作|制作|设计|做|出|来))\s*"
        r"(?:\d+|[一两二三四五六七八九十])\s*"
        r"(?:张|幅|版|个方向|个方案|方向|方案|种(?:风格|方向|方案|设计)?)"
        r"(?:\s*(?:风格|方向|版本|方案)?\s*(?:不同|不一样|各不相同|各异|差异化)(?:的)?)?",
        r"\1一张",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(
        r"(?:\d+|[一两二三四五六七八九十])\s*(?:个|种)?\s*"
        r"(?:不同|不一样|各不相同|各异|差异化)(?:的)?\s*(?:风格|方向|版本|方案)(?:的)?\s*"
        r"(海报|图片|图像|设计|作品|成图|封面|主视觉)",
        r"一张\1",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(
        r"(?:\d+|[一两二三四五六七八九十])\s*(?:个|种)?\s*"
        r"(?:风格|方向|版本|方案)\s*(?:不同|不一样|各不相同|各异|差异化)(?:的)?\s*"
        r"(海报|图片|图像|设计|作品|成图|封面|主视觉)",
        r"一张\1",
        cleaned,
        flags=re.I,
    )
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned).strip(" \t\r\n，,；;。")
    if not cleaned:
        cleaned = "生成一张完整成图"
    if CUSTOM_CANVAS_SINGLE_IMAGE_GUARD not in cleaned:
        cleaned = f"{cleaned}。{CUSTOM_CANVAS_SINGLE_IMAGE_GUARD}"
    return cleaned


def _custom_canvas_json_object(text: str) -> dict:
    raw = _clean_llm_text(text)
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, flags=re.I)
    if fenced:
        raw = fenced.group(1).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        raw = raw[start:end + 1]
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("模型没有返回 JSON 对象")
    return parsed


def _custom_canvas_variant_prompts(prompt: str, count: int, existing=None) -> List[str]:
    variants = [
        _custom_canvas_single_image_prompt(item, count)
        for item in (existing or [])
        if isinstance(item, str) and str(item or "").strip()
    ][:count]
    prompt = _custom_canvas_single_image_prompt(prompt, count)
    directions = (
        "保持主题与文案不变，采用主体居中、层级明确的构图。",
        "保持主题与文案不变，采用左右错位和大留白构图。",
        "保持主题与文案不变，采用近景主体与纵深背景构图。",
        "保持主题与文案不变，采用网格化信息与重点聚焦构图。",
        "保持主题与文案不变，采用强对角线动势构图。",
    )
    while len(variants) < count:
        direction = directions[len(variants) % len(directions)]
        variants.append(f"{prompt}\n第 {len(variants) + 1} 版：{direction}")
    return variants


def _custom_canvas_agent_fallback(req: CustomCanvasAgentReq) -> dict:
    brief = str(req.brief or "").strip()
    count = _custom_canvas_explicit_count(brief)
    lower = brief.lower()
    palette = "default"
    for key, words in (
        ("tech", ("科技", "智能", "ai", "未来", "数据", "算力")),
        ("finance", ("金融", "银行", "投资", "理财", "财富")),
        ("luxury", ("高端", "奢华", "旗舰", "黑金", "品质")),
        ("warm", ("温暖", "节日", "公益", "关怀", "治愈")),
        ("business", ("商务", "企业", "峰会", "发布会", "论坛")),
    ):
        if any(word in lower for word in words):
            palette = key
            break
    scene_label = {
        "enterprise_poster": "竖版企业海报",
        "airport_screen": "机场大屏",
        "banner": "横版网站 Banner",
        "brand_kv": "品牌主视觉",
    }.get(req.scene, "品牌主视觉")
    references = ""
    if req.references:
        references = "参考随附图片中的真实主体、Logo、产品和视觉关系，保持其外观与文字原样，不虚构图片细节；"
    topic = _custom_canvas_single_image_prompt(brief, count) if brief else "拟一版现代、专业、有清晰中文标题层级的商业视觉"
    prompt = (
        f"{references}生成一张 {req.size} 的完整{scene_label}。需求：{topic}。"
        "画面主体明确，主标题和副标题层级清楚，构图完整，留白合理，商业级质感，中文文字准确可读。"
    )
    prompt = _custom_canvas_single_image_prompt(prompt, count)
    return {
        "palette": palette,
        "prompt": prompt,
        "negativePrompt": CUSTOM_CANVAS_NEGATIVE,
        "caption": "已按需求整理为可直接生成完整成图的提示词。",
        "count": count,
        **({"variants": _custom_canvas_variant_prompts(prompt, count)} if count > 1 else {}),
    }


async def _custom_canvas_agent_llm(req: CustomCanvasAgentReq) -> dict:
    if not LLM_API_KEY:
        raise RuntimeError("语言模型未配置")
    fallback = _custom_canvas_agent_fallback(req)
    images = []
    for idx, value in enumerate((req.images or [])[:4], start=1):
        try:
            images.append(_custom_canvas_data_url(value, f"第 {idx} 张参考图", 12 * 1024 * 1024))
        except HTTPException:
            continue
    labels = [
        str(item.get("label") or "").strip()[:120]
        for item in (req.references or [])[:8]
        if isinstance(item, dict) and str(item.get("label") or "").strip()
    ]
    reference_note = ""
    if labels or images:
        reference_note = (
            "\n存在参考图。必须忠实利用参考图中的真实主体、产品、Logo、文字和构图关系；"
            "不要虚构看不到的细节，并在提示词中明确要求模型保持参考主体原样。"
        )
    system = "\n".join([
        "你是星阵的资深商业视觉设计师，把用户需求整理成一条可直接生成完整成图的提示词。",
        "只返回 JSON，不要 markdown：",
        '{"palette":"tech|business|finance|warm|luxury|default","prompt":"完整提示词",'
        '"negativePrompt":"英文负向词","caption":"一句话设计思路","count":1,"variants":[]}',
        "提示词需写明目标尺寸、画面主体、构图、准确的画面文字及位置、配色与质感。",
        "用户没有给标题时，拟一个 2 到 8 字的短主标题和一句副标题；不能把用户指令原话直接当作画面标题。",
        "默认中文；只有用户明确要求英文时才使用英文。",
        "count 仅根据用户明确要求的出图张数填写，最多 10；物体数量不等于出图张数。",
        "prompt 与 variants 的每一项都只能描述一张完整成图；不得把出图数量、多个版本或多个风格写入单项提示词，不得要求拼图、分屏或并排方案。",
        "多张时 variants 必须为独立完整提示词，保持主题和用户指定风格，只调整构图；用户没指定风格才可变化方向。",
        "negativePrompt 最多 7 个英文词组，不要把 text、title、words 写入负向词。",
    ])
    user_text = (
        f"需求：{str(req.brief or '').strip() or '拟一版有品质感的默认商业视觉'}\n"
        f"场景：{req.scene}\n目标尺寸：{req.size}"
        + (f"\n参考图名称：{'、'.join(labels)}" if labels else "")
        + reference_note
    )
    can_see = bool(images and LLM_VISION_MODEL)
    messages = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": (
                [{"type": "text", "text": user_text}]
                + [{"type": "image_url", "image_url": {"url": image}} for image in images]
                if can_see else user_text
            ),
        },
    ]
    body = {
        "model": LLM_VISION_MODEL if can_see else LLM_MODEL,
        "temperature": 0.7,
        "messages": messages,
        "response_format": {"type": "json_object"},
    }
    response = await _call_llm(body, force_deployed_model=not can_see)
    if response.status_code >= 400:
        raise _llm_error(response.status_code, _http_detail(response.json() if "json" in (response.headers.get("content-type") or "") else response.text[:800]))
    data = response.json()
    parsed = _custom_canvas_json_object(_deep_get(data, ("choices", 0, "message", "content"), default=""))
    prompt = str(parsed.get("prompt") or fallback["prompt"]).strip()
    palette = str(parsed.get("palette") or "default").strip()
    if palette not in CUSTOM_CANVAS_PALETTES:
        palette = "default"
    count = _custom_canvas_explicit_count(req.brief)
    prompt = _custom_canvas_single_image_prompt(prompt, count)
    result = {
        "palette": palette,
        "prompt": prompt,
        "negativePrompt": str(parsed.get("negativePrompt") or CUSTOM_CANVAS_NEGATIVE).strip(),
        "caption": str(parsed.get("caption") or fallback["caption"]).strip(),
        "count": count,
    }
    if count > 1:
        result["variants"] = _custom_canvas_variant_prompts(prompt, count, parsed.get("variants"))
    return result


async def _custom_canvas_generated_image(prompt: str, size: str, refs: List[ImageRef]) -> dict:
    clean_prompt = str(prompt or "").strip()
    if not clean_prompt:
        raise HTTPException(400, "图片提示词为空")
    if len(clean_prompt) > 12000:
        raise HTTPException(400, "图片提示词过长")
    ratio = _custom_canvas_ratio(size)
    result = await image_generate(ImageGenerateReq(
        prompt=f"{clean_prompt}\n最终输出画布：{size}，比例 {ratio}。",
        refs=refs,
        ratio=ratio,
        strictRatio=True,
    ))
    used_refs = int(result.get("usedRefs") or 0)
    if refs and used_refs < len(refs):
        raise HTTPException(502, f"参考图未完整送达图片模型（实际使用 {used_refs}/{len(refs)}），本次已停止，避免错误出图")
    output_ratio = _normalize_image_ratio(str(result.get("ratio") or ratio))
    width, height = _custom_canvas_native_size(output_ratio)
    return {
        "dataUrl": result["dataUrl"],
        "width": width,
        "height": height,
        "usedRefs": used_refs,
        "skippedRefs": int(result.get("skippedRefs") or 0),
        "model": result.get("model") or "",
        "mode": result.get("mode") or "",
    }


async def _custom_canvas_mask_edit(req: CustomCanvasEditRegionReq) -> dict:
    if not IMAGE_API_KEY:
        raise HTTPException(500, "服务器未配置图片 API Key")
    image = _custom_canvas_data_url(req.image, "待编辑图片")
    mask = str(req.mask or "").strip()
    if not re.match(r"^data:image/png;base64,", mask, flags=re.I):
        raise HTTPException(400, "区域遮罩必须为 PNG")
    if len(mask) > 24 * 1024 * 1024:
        raise HTTPException(413, "区域遮罩过大，请缩小编辑范围后重试")
    endpoint = _image_endpoint()
    if not _image_is_maas_mode(model=IMAGE_MODEL, endpoint=endpoint):
        raise HTTPException(501, "当前图片模型不支持精确遮罩编辑，已停止以避免改动框选区域之外的内容")
    ratio = _custom_canvas_ratio(width=req.width, height=req.height)
    ref_file = _data_url_to_file(image, "canvas-region-source.png")
    prompt = (
        f"仅在遮罩指定的编辑区域内：{str(req.instruction or '').strip() or '优化细节'}。"
        "编辑区域之外的所有内容必须与原图完全一致，不得改动。"
    )
    model = _maas_model_for_refs(IMAGE_MODEL, True)
    body = _maas_image_body(prompt, model, ratio, [ref_file])
    body["mask"] = {"image_url": mask}
    body["input_fidelity"] = "high"
    body["quality"] = "low"
    headers = {
        "Authorization": "Bearer " + IMAGE_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
    }
    request_endpoint = _maas_endpoint_for_refs(endpoint, True)
    try:
        async with httpx.AsyncClient(**_httpx_async_client_kwargs(
            timeout=httpx.Timeout(180.0, connect=12.0),
            trust_env=False,
            follow_redirects=True,
        )) as client:
            response, data = await _post_json_with_retry(client, request_endpoint, body, headers)
            if response.status_code >= 400:
                raise HTTPException(response.status_code, _http_detail(data) or "区域编辑失败")
            output = _image_from_response(data, "image/jpeg")
            if not output:
                raise HTTPException(502, "区域编辑没有返回图片")
            output = await _generated_image_to_data_url(client, output, ratio)
    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"无法连接区域编辑模型：{exc.__class__.__name__} {exc}")
    width, height = _custom_canvas_native_size(ratio)
    return {"dataUrl": output, "width": width, "height": height}


@app.get("/api/custom-canvas/config")
def custom_canvas_config(me=Depends(require_member)):
    _require_custom_creator(me)
    available = CUSTOM_CANVAS_DIR.is_dir() and (CUSTOM_CANVAS_DIR / "index.html").is_file()
    published_projects = []
    for item in store.list_custom_projects(me["id"], "canvas"):
        state = item.get("projectState") if isinstance(item.get("projectState"), dict) else {}
        source_project_id = str(state.get("sourceProjectId") or "").strip()
        delivery_id = str(item.get("publishedDeliveryId") or "").strip()
        if (
            item.get("status") != "published"
            or not source_project_id
            or not delivery_id
        ):
            continue
        published_projects.append({
            "projectId": source_project_id[:180],
            "deliveryId": delivery_id[:160],
            "publishedAt": int(item.get("publishedAt") or item.get("updatedAt") or 0),
            "itemIds": [
                str(value)[:180]
                for value in (state.get("publishedItemIds") or [])[:20]
                if str(value or "").strip()
            ],
        })
    return {
        "ok": True,
        "available": available,
        "basePath": "/XZ-Design/",
        "persistence": "server-owner-scoped-with-browser-cache",
        "ownerScope": "authenticated-member",
        "storageNamespace": store.custom_canvas_storage_namespace(me["id"]),
        "publishedProjects": published_projects,
        "features": [
            "agent",
            "generate",
            "references",
            "enhance",
            "mask-edit",
            "transform",
            "export-bridge",
            "published-state",
            "server-draft-sync",
            "verified-legacy-recovery",
        ],
    }


def _custom_canvas_draft_value_error(exc):
    reason = str(exc)
    if reason in {
        "custom_canvas_project_too_large",
        "custom_canvas_draft_too_large",
        "custom_canvas_blob_too_large",
        "custom_canvas_total_blob_too_large",
        "custom_canvas_payload_too_large",
        "custom_canvas_too_many_items",
        "custom_canvas_too_many_messages",
        "custom_canvas_too_many_blobs",
        "custom_canvas_owner_blob_quota",
    }:
        raise HTTPException(413, "无限画布草稿或图片过大，请减少节点后重试")
    if reason in {
        "unsupported_custom_canvas_image_type",
        "unsupported_custom_canvas_data_url",
        "invalid_custom_canvas_image",
        "unsafe_custom_canvas_svg",
    }:
        raise HTTPException(415, "无限画布草稿只支持安全的 PNG、JPEG、WebP、GIF 或 SVG 图片")
    if reason in {
        "custom_canvas_blob_missing",
        "custom_canvas_blob_conflict",
        "invalid_custom_canvas_stored_state",
        "invalid_custom_canvas_blob_ref",
    }:
        raise HTTPException(500, "无限画布草稿图片存储异常，请保留本地草稿并联系管理员")
    raise HTTPException(400, "无限画布草稿数据格式无效")


def _custom_canvas_draft_error(error):
    if error == "not_found":
        # 不区分“确实不存在”和“属于其他成员”，管理员也不能借此探测成员草稿。
        raise HTTPException(404, "无限画布草稿不存在")
    if error == "deleted":
        raise HTTPException(410, "无限画布草稿已删除，旧标签页不能恢复该项目")
    if error == "empty_snapshot":
        raise HTTPException(409, "服务器已有图片或节点，已拒绝空草稿覆盖")
    if error == "server_newer":
        raise HTTPException(409, "服务器草稿更新，刷新后再继续编辑")
    if error == "conflict":
        raise HTTPException(409, "无限画布草稿版本冲突，刷新后再继续编辑")
    raise HTTPException(400, "无限画布草稿请求无效")


@app.post("/api/custom-canvas/session")
def custom_canvas_session_create(
    request: Request,
    response: Response,
    authorization: str = Header(default=""),
    me=Depends(require_member),
):
    _require_custom_creator(me)
    token = str(authorization or "").replace("Bearer ", "").strip()
    # Keep the credential out of JSON, URLs and JavaScript-readable storage.
    # The dependency above already validates it; this explicit check prevents a
    # future refactor from minting a cookie for a different member object.
    authenticated = _member_from_authorization(f"Bearer {token}")
    if str(authenticated.get("id") or "") != str(me.get("id") or ""):
        raise HTTPException(401, "登录状态不匹配")
    forwarded_proto = str(request.headers.get("x-forwarded-proto") or "")
    is_https = (forwarded_proto.split(",", 1)[0].strip().lower() == "https") \
        or request.url.scheme == "https"
    response.set_cookie(
        CUSTOM_CANVAS_SESSION_COOKIE,
        token,
        max_age=CUSTOM_CANVAS_SESSION_TTL,
        httponly=True,
        secure=is_https,
        samesite="strict",
        path="/api/custom-canvas/blobs",
    )
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True, "expiresIn": CUSTOM_CANVAS_SESSION_TTL}


@app.get("/api/custom-canvas/blobs/{content_hash}")
def custom_canvas_blob_get(
    content_hash: str,
    request: Request,
    authorization: str = Header(default=""),
):
    cookie_token = str(request.cookies.get(CUSTOM_CANVAS_SESSION_COOKIE) or "").strip()
    header_token = str(authorization or "").replace("Bearer ", "").strip()
    me = _member_from_authorization(f"Bearer {header_token or cookie_token}")
    _require_custom_creator(me)
    try:
        blob, error = store.get_custom_canvas_blob(me["id"], content_hash)
    except ValueError:
        blob, error = None, "not_found"
    # Missing hashes and hashes owned by another member are intentionally
    # indistinguishable; the URL is not an ownership oracle.
    if error or not blob:
        raise HTTPException(404, "无限画布图片不存在")
    response = ranged_file_response(
        request,
        blob["path"],
        media_type=blob["mime"],
        cache_seconds=31_536_000,
    )
    response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
    # The same content hash may exist in more than one owner namespace. Keep
    # authenticated browser-cache variants separate across login sessions.
    response.headers["Vary"] = "Cookie, Authorization"
    response.headers["X-Content-Type-Options"] = "nosniff"
    if blob["mime"] == "image/svg+xml":
        response.headers["Content-Security-Policy"] = (
            "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
        )
    return response


@app.get("/api/custom-canvas/projects")
def custom_canvas_projects_list(me=Depends(require_member)):
    _require_custom_creator(me)
    try:
        items, tombstones = store.list_custom_canvas_drafts(me["id"])
    except ValueError as exc:
        _custom_canvas_draft_value_error(exc)
    return {"items": items, "tombstones": tombstones}


@app.get("/api/custom-canvas/projects/{source_id}")
def custom_canvas_projects_get(source_id: str, me=Depends(require_member)):
    _require_custom_creator(me)
    try:
        result, error = store.get_custom_canvas_draft(me["id"], source_id)
    except ValueError as exc:
        _custom_canvas_draft_value_error(exc)
    if error:
        _custom_canvas_draft_error(error)
    return result


@app.put("/api/custom-canvas/projects/{source_id}")
def custom_canvas_projects_put(
    source_id: str,
    req: CustomCanvasProjectDraftReq,
    me=Depends(require_member),
):
    _require_custom_creator(me)
    payload = (
        req.model_dump()
        if hasattr(req, "model_dump")
        else req.dict()
    )
    try:
        result, error, outcome = store.save_custom_canvas_draft(
            me["id"],
            source_id,
            payload,
        )
    except ValueError as exc:
        _custom_canvas_draft_value_error(exc)
    if error:
        _custom_canvas_draft_error(error)
    return {**result, "outcome": outcome}


@app.delete("/api/custom-canvas/projects/{source_id}")
def custom_canvas_projects_delete(source_id: str, me=Depends(require_member)):
    _require_custom_creator(me)
    try:
        tombstone, error = store.delete_custom_canvas_draft(me["id"], source_id)
    except ValueError as exc:
        _custom_canvas_draft_value_error(exc)
    if error:
        _custom_canvas_draft_error(error)
    return {"ok": True, "tombstone": tombstone}


@app.post("/api/custom-canvas/agent")
async def custom_canvas_agent(req: CustomCanvasAgentReq, me=Depends(require_member)):
    _require_custom_creator(me)
    try:
        return await _custom_canvas_agent_llm(req)
    except Exception as exc:
        print(f"[custom-canvas] agent fallback: {exc.__class__.__name__}: {str(exc)[:240]}", file=sys.stderr)
        return _custom_canvas_agent_fallback(req)


@app.post("/api/custom-canvas/generate")
async def custom_canvas_generate(req: CustomCanvasGenerateReq, me=Depends(require_member)):
    _require_custom_creator(me)
    refs = _custom_canvas_image_refs(req.references)
    prompt = str(req.prompt or "").strip()
    negative = ", ".join(part.strip() for part in str(req.negativePrompt or "").split(",")[:7] if part.strip())
    if negative:
        prompt += f"\n画面中不要出现：{negative}。"
    images = await asyncio.gather(*[
        _custom_canvas_generated_image(prompt, req.size, refs)
        for _ in range(req.count)
    ])
    prefix = str(req.labelPrefix or "Draft").strip()[:80] or "Draft"
    output = []
    for index, image in enumerate(images):
        variant = req.startVariant + index
        output.append({
            "dataUrl": image["dataUrl"],
            "width": image["width"],
            "height": image["height"],
            "label": f"{prefix} {variant:02d}",
            "variant": variant,
        })
    receipt = images[0] if images else {}
    return {
        "images": output,
        "source": "platform",
        "usedRefs": receipt.get("usedRefs", 0),
        "skippedRefs": receipt.get("skippedRefs", 0),
        "model": receipt.get("model", ""),
        "mode": receipt.get("mode", ""),
    }


@app.post("/api/custom-canvas/enhance")
async def custom_canvas_enhance(req: CustomCanvasEnhanceReq, me=Depends(require_member)):
    _require_custom_creator(me)
    image = _custom_canvas_data_url(req.image, "待增强图片")
    prompt = (
        "以参考图为唯一内容来源，保持原图比例、构图、主体位置、品牌元素、全部文字与配色准确不变；"
        "显著提升清晰度、边缘锐度、材质纹理、画面层次和远距离可读性，不新增元素、水印或文字。"
    )
    result = await _custom_canvas_generated_image(
        prompt,
        req.size,
        _custom_canvas_image_refs([image]),
    )
    return {
        "images": [{
            "dataUrl": result["dataUrl"],
            "width": result["width"],
            "height": result["height"],
        }],
        "source": "platform",
    }


@app.post("/api/custom-canvas/edit-region")
async def custom_canvas_edit_region(req: CustomCanvasEditRegionReq, me=Depends(require_member)):
    _require_custom_creator(me)
    return {"image": await _custom_canvas_mask_edit(req)}


@app.post("/api/custom-canvas/transform")
async def custom_canvas_transform(req: CustomCanvasTransformReq, me=Depends(require_member)):
    _require_custom_creator(me)
    image = _custom_canvas_data_url(req.image, "待处理图片")
    prompt = str(req.prompt or "").strip() or "优化这张图"
    fidelity = "high" if str(req.fidelity or "").lower() != "low" else "low"
    prompt += (
        "\n以参考图为核心，必须保留主体身份、Logo 与文字内容，允许按指令重组视觉风格。"
        if fidelity == "high"
        else "\n以参考图主体为内容来源，按指令进行明显的视觉风格变化。"
    )
    result = await _custom_canvas_generated_image(
        prompt,
        req.size,
        _custom_canvas_image_refs([image]),
    )
    return {"image": {
        "dataUrl": result["dataUrl"],
        "width": result["width"],
        "height": result["height"],
    }}


def _custom_project_error(error):
    if error == "forbidden":
        raise HTTPException(403, "无权访问其他成员的定制创作项目")
    if error == "not_found":
        raise HTTPException(404, "定制创作项目不存在")
    raise HTTPException(400, "定制创作项目请求无效")


def _save_custom_project(me, req, project_id=""):
    _require_custom_creator(me)
    payload = (
        req.model_dump(exclude_unset=True)
        if hasattr(req, "model_dump")
        else req.dict(exclude_unset=True)
    )
    # “已发布”和交付单关联必须由后续原子发布接口写入，普通草稿保存不能伪造。
    if payload.get("status") == "published" or "publishedDeliveryId" in payload:
        raise HTTPException(400, "发布状态只能由定制创作发布接口更新")
    try:
        item, error = store.save_custom_project(me["id"], payload, project_id)
    except ValueError as exc:
        reason = str(exc)
        messages = {
            "invalid_custom_project_kind": "项目类型只支持视频工坊或无限画布",
            "invalid_custom_project_status": "项目状态无效",
            "custom_project_state_too_large": "项目状态过大，请先把图片或视频上传为独立输出文件",
            "custom_project_binary_not_allowed": "项目状态不能内嵌 Base64 图片、视频或音频，请使用输出文件接口",
        }
        raise HTTPException(400, messages.get(reason, "定制创作项目保存失败"))
    if error:
        _custom_project_error(error)
    return item


@app.get("/api/custom-projects")
def custom_projects_list(kind: str = "", me=Depends(require_member)):
    _require_custom_creator(me)
    try:
        return {"items": store.list_custom_projects(me["id"], kind)}
    except ValueError:
        raise HTTPException(400, "项目类型只支持 video 或 canvas")


@app.post("/api/custom-projects")
def custom_projects_create(req: CustomProjectReq, me=Depends(require_member)):
    return {"ok": True, "project": _save_custom_project(me, req)}


@app.get("/api/custom-projects/{project_id}")
def custom_projects_get(project_id: str, me=Depends(require_member)):
    _require_custom_creator(me)
    item, error = store.get_custom_project(project_id, me["id"])
    if error:
        _custom_project_error(error)
    return {"project": item}


@app.put("/api/custom-projects/{project_id}")
def custom_projects_update(project_id: str, req: CustomProjectReq, me=Depends(require_member)):
    return {"ok": True, "project": _save_custom_project(me, req, project_id)}


@app.post("/api/custom-projects/{project_id}/publish")
def custom_projects_publish(
    project_id: str,
    req: CustomProjectPublishReq,
    me=Depends(require_member),
):
    _require_custom_creator(me)
    payload = (
        req.model_dump()
        if hasattr(req, "model_dump")
        else req.dict()
    )
    result, error = store.publish_custom_project_bundle(
        project_id,
        me["id"],
        payload,
    )
    if error in {
        "delivery_not_found",
        "delivery_mismatch",
        "delivery_asset_missing",
        "delivery_asset_mismatch",
        "delivery_asset_deleted",
        "account_not_found",
        "account_deleted",
        "account_mode_mismatch",
    }:
        raise HTTPException(409, "交付记录尚未完整同步或与当前项目不匹配")
    if error == "invalid_publish_request":
        raise HTTPException(400, "缺少定制项目或交付记录编号")
    if error:
        _custom_project_error(error)
    return {"ok": True, **result}


@app.post("/api/custom-projects/{project_id}/unpublish")
def custom_projects_unpublish(
    project_id: str,
    req: CustomProjectPublishReq,
    me=Depends(require_member),
):
    _require_custom_creator(me)
    result, error = store.unpublish_custom_project_delivery(
        project_id,
        me["id"],
        req.deliveryId,
    )
    if error == "invalid_publish_request":
        raise HTTPException(400, "缺少定制项目或交付记录编号")
    if error == "delivery_already_published":
        raise HTTPException(409, "供应商已回传发布链接或交付已标记为已发布，无法回撤")
    if error == "delivery_already_downloaded":
        raise HTTPException(409, "供应商已下载该交付，无法回撤")
    if error in {"delivery_not_found", "delivery_mismatch"}:
        raise HTTPException(409, "待回撤交付不存在或与当前项目不匹配")
    if error:
        _custom_project_error(error)
    return {"ok": True, **result}


@app.delete("/api/custom-projects/{project_id}")
def custom_projects_delete(project_id: str, me=Depends(require_member)):
    _require_custom_creator(me)
    ok, error = store.delete_custom_project(project_id, me["id"])
    if error:
        _custom_project_error(error)
    return {"ok": bool(ok)}


@app.put("/api/db/{collection}")
def api_put(collection: str, req: PutReq, me=Depends(require_member)):
    """写穿透：管理员管理共享配置，创作者只能同步本人或关联交付的数据。"""
    if collection in store.CUSTOM_COLLECTIONS:
        raise HTTPException(403, "定制创作数据必须使用专用接口，禁止批量回推")
    if me["role"] in {"supplier_parent", "supplier_child"}:
        if collection != "assets":
            raise HTTPException(403, "供应商账号只能更新交付清单")
        assigned = store.supplier_account_ids_for_child(me["id"]) if me["role"] == "supplier_child" else None
        for item in req.items or []:
            if not isinstance(item, dict) or (not item.get("delivered") and not item.get("shared")):
                raise HTTPException(403, "只能更新已交付素材")
            if assigned is not None and item.get("accountId") not in assigned:
                raise HTTPException(403, "无权更新未分配账号的素材")
    try:
        result = {"written": len(req.items or []), "denied": 0}
        if me["role"] in {"supplier_parent", "supplier_child"}:
            result["written"] = store.upsert_docs(collection, req.items)
        elif collection == "assets" and me["role"] in {"admin", "editor"}:
            store.upsert_member_assets(me["id"], me["role"], req.items)
        elif collection == "voicePresets":
            store.upsert_voice_presets(me["id"], me["role"], req.items)
        else:
            result = store.upsert_member_collection(me["id"], me["role"], collection, req.items)
    except PermissionError:
        raise HTTPException(403, "当前账号无权修改该共享配置或其他成员的业务数据")
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("suspicious_account_bulk"):
            raise HTTPException(409, "检测到旧浏览器缓存正在批量回推账号，服务器已拒绝本次写入。请刷新页面后重新登录。")
        raise HTTPException(400, "未知集合")
    return {
        "ok": True,
        "n": int(result.get("written") or 0),
        **({"denied": int(result.get("denied") or 0)} if result.get("denied") else {}),
    }


@app.delete("/api/db/{collection}/{doc_id}")
def api_del(collection: str, doc_id: str, me=Depends(require_member)):
    if collection in store.CUSTOM_COLLECTIONS:
        raise HTTPException(403, "定制创作数据必须使用专用接口")
    if me["role"] in {"supplier_parent", "supplier_child"}:
        raise HTTPException(403, "供应商账号不能删除业务数据")
    try:
        store.delete_member_doc(
            collection,
            doc_id,
            me["id"],
            me["role"],
            protect_custom_delivery=True,
        )
    except PermissionError:
        raise HTTPException(403, "当前账号无权删除该共享配置或其他成员的业务数据")
    except ValueError as exc:
        if str(exc) == "custom_delivery_requires_unpublish":
            raise HTTPException(409, "定制创作交付必须通过项目回撤接口删除")
        raise HTTPException(400, "未知集合")
    return {"ok": True}


def _safe_file_stem(value: str) -> str:
    s = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in str(value or ""))
    return (s or uuid.uuid4().hex)[:80]


def _safe_ext(filename: str, mime: str = "") -> str:
    mime_ext = mimetypes.guess_extension((mime or "").split(";")[0].strip()) or ""
    if mime_ext in (".jpe",):
        mime_ext = ".jpg"
    ext = Path(filename or "").suffix.lower()
    known_exts = {
        ".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp3", ".wav", ".m4a",
        ".aac", ".mp4", ".mov", ".webm", ".json", ".txt", ".csv", ".zip",
        ".pdf",
    }
    if ext in known_exts:
        return ext
    if mime_ext and len(mime_ext) <= 12:
        return mime_ext
    if ext and len(ext) <= 12 and all(ch.isalnum() or ch == "." for ch in ext):
        return ext
    return ".bin"


def _media_type_for_path(path: Path) -> str:
    media = mimetypes.guess_type(path.name)[0]
    if media and media != "application/octet-stream":
        return media
    try:
        head = path.read_bytes()[:16]
    except Exception:
        return media or "application/octet-stream"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return media or "application/octet-stream"


def _upload_path(name: str) -> Path:
    safe = Path(name).name
    path = UPLOAD_DIR / safe
    if not str(path.resolve()).startswith(str(UPLOAD_DIR.resolve())):
        raise HTTPException(400, "非法文件名")
    return path


@app.put("/api/files/{asset_id}")
async def file_put(asset_id: str, req: Request, filename: str = "", mime: str = "", me=Depends(require_member)):
    """把资产二进制保存到服务端，返回所有成员可访问的同源 URL。
    不使用 multipart，避免老 Python/FastAPI 环境额外安装 python-multipart。"""
    if not store.can_write_asset_file(asset_id, me["id"], me["role"]):
        raise HTTPException(403, "不能覆盖其他成员的私有素材文件")
    data = await req.body()
    if not data:
        raise HTTPException(400, "文件为空")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stem = _safe_file_stem(f"{me['id']}--{asset_id}")
    for old in UPLOAD_DIR.glob(stem + ".*"):
        try:
            old.unlink()
        except Exception:
            pass
    ext = _safe_ext(filename, mime)
    stored = stem + ext
    path = _upload_path(stored)
    path.write_bytes(data)
    media = (mime or mimetypes.guess_type(stored)[0] or "application/octet-stream").split(";")[0]
    return {
        "ok": True,
        "name": stored,
        "url": "/api/files/" + stored,
        "fileUrl": "/api/files/" + stored,
        "mime": media,
        "size": len(data),
    }


@app.get("/api/files/{name}")
def file_get(name: str, request: Request):
    path = _upload_path(name)
    if not path.exists():
        raise HTTPException(404, "文件不存在或已被清理")
    media = _media_type_for_path(path)
    return ranged_file_response(request, path, media_type=media)


@app.delete("/api/files/{name}")
def file_delete(name: str, me=Depends(require_member)):
    if not store.can_delete_asset_file(Path(name).name, me["id"], me["role"]):
        raise HTTPException(403, "不能删除其他成员的私有素材文件")
    path = _upload_path(name)
    if path.exists():
        path.unlink()
    return {"ok": True}


@app.get("/api/members")
def members_list(me=Depends(require_admin)):
    return store.list_members()


@app.get("/api/supplier/children")
def supplier_children(me=Depends(require_supplier_parent)):
    return store.list_supplier_children(me["id"], include_all=True)


@app.get("/api/supplier/members")
def supplier_members(me=Depends(require_supplier_parent)):
    return store.list_supplier_members()


@app.post("/api/supplier/children")
def supplier_children_create(req: SupplierChildrenReq, me=Depends(require_supplier_parent)):
    try:
        return store.create_supplier_children(me["id"], [(x.model_dump() if hasattr(x, "model_dump") else x.dict()) for x in req.items])
    except ValueError as exc:
        if str(exc) == "username_exists":
            raise HTTPException(409, "用户名已存在")
        raise HTTPException(400, "姓名、用户名和初始密码必填")
    except sqlite3.IntegrityError:
        raise HTTPException(409, "用户名已存在")
    except sqlite3.Error as exc:
        raise HTTPException(503, "账号存储暂时不可用，请刷新后重试") from exc


@app.put("/api/supplier/children/{mid}")
def supplier_child_update(mid: str, req: MemberReq, me=Depends(require_supplier_parent)):
    row = store.supplier_child_for(me["id"], mid, include_all=True)
    if not row:
        raise HTTPException(404, "供应商子账号不存在")
    username = req.username.strip() if req.username else None
    if username:
        existing = store.get_member_by_username(username)
        if existing and existing[0] != mid:
            raise HTTPException(409, "用户名已存在")
    updated = store.update_member(mid, name=req.name or None, username=username, pin=req.pin or None)
    return store.member_public(updated)


@app.delete("/api/supplier/children/{mid}")
def supplier_child_delete(mid: str, me=Depends(require_supplier_parent)):
    row = store.supplier_child_for(me["id"], mid, include_all=True)
    if not row:
        raise HTTPException(404, "供应商子账号不存在")
    store.delete_member(mid)
    return {"ok": True}


@app.get("/api/supplier/bindings")
def supplier_bindings(me=Depends(require_supplier_parent)):
    return store.supplier_bindings(me["id"], include_all=True)


@app.put("/api/supplier/children/{mid}/accounts")
def supplier_child_accounts(mid: str, req: SupplierBindReq, me=Depends(require_supplier_parent)):
    ok = store.set_supplier_child_accounts(me["id"], mid, req.accountIds, me["id"], include_all=True)
    if not ok:
        raise HTTPException(404, "供应商子账号不存在")
    return {"ok": True, "bindings": store.supplier_bindings(me["id"], include_all=True)}


@app.get("/api/supplier/activity")
def supplier_activity(me=Depends(require_supplier_parent)):
    return store.list_supplier_activity(me["id"], include_all=True)


@app.put("/api/supplier/members/{mid}")
def supplier_member_update(mid: str, req: MemberReq, me=Depends(require_supplier_parent)):
    row = store.get_member(mid)
    if not row or row[4] not in {"supplier_parent", "supplier_child"}:
        raise HTTPException(404, "供应商账号不存在")
    username = req.username.strip() if req.username else None
    if username:
        existing = store.get_member_by_username(username)
        if existing and existing[0] != mid:
            raise HTTPException(409, "用户名已存在")
    updated = store.update_member(mid, name=req.name or None, username=username, pin=req.pin or None)
    return store.member_public(updated)


@app.post("/api/supplier/activity")
def supplier_activity_add(req: SupplierActivityReq, me=Depends(require_member)):
    if me["role"] not in {"supplier_parent", "supplier_child"}:
        raise HTTPException(403, "需要供应商权限")
    parent_id = me.get("parentId") or (me["id"] if me["role"] == "supplier_parent" else "")
    store.add_supplier_activity(parent_id, me["id"] if me["role"] == "supplier_child" else "", me["id"], req.action, req.accountId, req.assetId, req.detail)
    return {"ok": True}


@app.put("/api/supplier/assets/{asset_id}/views")
def supplier_asset_views(asset_id: str, req: SupplierViewsReq, me=Depends(require_member)):
    item, err = store.update_supplier_asset_views(asset_id, req.viewCount, me["id"], me["role"])
    if err == "forbidden":
        raise HTTPException(403, "只有供应商账号可以更新观看量")
    if err == "unassigned":
        raise HTTPException(403, "无权更新未分配账号的观看量")
    if err:
        raise HTTPException(404, "交付素材不存在")
    parent_id = me.get("parentId") or (me["id"] if me["role"] == "supplier_parent" else "")
    store.add_supplier_activity(parent_id, me["id"] if me["role"] == "supplier_child" else "", me["id"], "update_views", item.get("accountId") or "", asset_id, "更新了观看量")
    return {"ok": True, "asset": item}


@app.put("/api/supplier/assets/{asset_id}/downloaded")
def supplier_asset_downloaded(asset_id: str, me=Depends(require_member)):
    item, err = store.mark_supplier_asset_downloaded(asset_id, me["id"], me["role"])
    if err == "forbidden":
        raise HTTPException(403, "只有供应商账号可以标记下载状态")
    if err == "unassigned":
        raise HTTPException(403, "无权下载未分配账号的素材")
    if err:
        raise HTTPException(404, "交付素材不存在")
    parent_id = me.get("parentId") or (me["id"] if me["role"] in {"supplier_parent", "supplier"} else "")
    store.add_supplier_activity(parent_id, me["id"] if me["role"] == "supplier_child" else "", me["id"], "download", item.get("accountId") or "", asset_id, "下载了交付素材")
    return {"ok": True, "asset": item}


@app.put("/api/supplier/assets/{asset_id}/published-link")
def supplier_asset_published_link(asset_id: str, req: SupplierPublishedLinkReq, me=Depends(require_member)):
    item, analytics_link, err = store.update_supplier_asset_published_link(
        asset_id, req.url, req.note, req.title, req.rawText, me["id"], me["role"]
    )
    if err == "forbidden":
        raise HTTPException(403, "只有供应商账号可以回传发布链接")
    if err == "unassigned":
        raise HTTPException(403, "无权更新未分配账号的发布链接")
    if err == "invalid_url":
        raise HTTPException(400, "发布链接仅支持完整的 http:// 或 https:// 地址")
    if err == "not_delivered":
        raise HTTPException(400, "只能为已交付素材回传发布链接")
    if err:
        raise HTTPException(404, "交付素材不存在")
    parent_id = me.get("parentId") or (me["id"] if me["role"] in {"supplier_parent", "supplier"} else "")
    store.add_supplier_activity(
        parent_id,
        me["id"] if me["role"] == "supplier_child" else "",
        me["id"],
        "return_link",
        item.get("accountId") or "",
        asset_id,
        "回传或更新了发布链接",
    )
    return {"ok": True, "asset": item, "analyticsLink": analytics_link}


@app.put("/api/supplier/accounts/{account_id}/homepage")
def supplier_account_homepage(account_id: str, req: SupplierHomepageReq, me=Depends(require_member)):
    item, err = store.update_supplier_account_homepage(account_id, req.homepageUrl, me["id"], me["role"])
    if err == "forbidden":
        raise HTTPException(403, "只有供应商母账号可以编辑主页链接")
    if err == "invalid_url":
        raise HTTPException(400, "主页链接仅支持 http:// 或 https://")
    if err:
        raise HTTPException(404, "账号不存在")
    return {"ok": True, "account": item}


def _remark_http_error(err):
    if err == "forbidden":
        raise HTTPException(403, "无权查看或回复这条发布内容")
    if err == "empty":
        raise HTTPException(400, "备注内容不能为空")
    raise HTTPException(404, "发布内容不存在")


@app.get("/api/deliveries/{asset_id}/remarks")
def delivery_remarks(asset_id: str, me=Depends(require_member)):
    data, err = store.delivery_remarks(asset_id, me["id"], me["role"])
    if err:
        _remark_http_error(err)
    return data


@app.post("/api/deliveries/{asset_id}/remarks")
def delivery_remark_add(asset_id: str, req: DeliveryRemarkReq, me=Depends(require_member)):
    item, err = store.add_delivery_remark(asset_id, me, req.text)
    if err:
        _remark_http_error(err)
    return {"ok": True, "asset": item}


@app.put("/api/deliveries/{asset_id}/remarks/read")
def delivery_remarks_read(asset_id: str, me=Depends(require_member)):
    item, err = store.mark_delivery_remarks_read(asset_id, me["id"], me["role"])
    if err:
        _remark_http_error(err)
    return {"ok": True, "asset": item}


@app.post("/api/members")
def members_add(req: MemberReq, me=Depends(require_admin)):
    if not req.username.strip() or not req.pin:
        raise HTTPException(400, "用户名与初始密码必填")
    if store.get_member_by_username(req.username.strip()):
        raise HTTPException(409, "用户名已存在")
    role = _clean_role(req.role)
    parent_id = req.parentId.strip() if role == "supplier_child" and req.parentId else None
    return store.member_public(store.add_member(req.name or req.username, req.username.strip(), req.pin, role, parent_id))


@app.put("/api/members/{mid}")
def members_update(mid: str, req: MemberReq, me=Depends(require_admin)):
    username = req.username.strip() if req.username else None
    if username:
        existing = store.get_member_by_username(username)
        if existing and existing[0] != mid:
            raise HTTPException(409, "用户名已存在")
    role = _clean_role(req.role) if req.role else None
    parent_id = req.parentId.strip() if role == "supplier_child" and req.parentId else None
    row = store.update_member(mid, name=req.name or None, username=username, role=role, pin=req.pin or None, parent_id=parent_id)
    if not row:
        raise HTTPException(404, "成员不存在")
    return store.member_public(row)


@app.delete("/api/members/{mid}")
def members_delete(mid: str, me=Depends(require_admin)):
    if mid == me["id"]:
        raise HTTPException(400, "不能删除当前登录的自己")
    store.delete_member(mid)
    return {"ok": True}


@app.get("/api/member-requests")
def member_requests_list(status: str = "", me=Depends(require_member)):
    if me["role"] not in {"admin", "supplier_parent"}:
        raise HTTPException(403, "需要成员管理权限")
    st = status if status in {"pending", "approved", "rejected"} else None
    rows = store.list_member_requests(st)
    return rows if me["role"] == "admin" else [x for x in rows if x.get("role") == "supplier_child"]


@app.post("/api/member-requests/{rid}/approve")
def member_requests_approve(rid: str, me=Depends(require_member)):
    if me["role"] not in {"admin", "supplier_parent"}:
        raise HTTPException(403, "需要成员管理权限")
    request_row = store.get_member_request(rid)
    if me["role"] == "admin" and request_row and request_row[4] == "supplier_child":
        raise HTTPException(403, "供应商子账号申请需由供应商管理员审批")
    if me["role"] == "supplier_parent" and (not request_row or request_row[4] != "supplier_child"):
        raise HTTPException(403, "只能审批供应商子账号申请")
    row, err = store.approve_member_request(rid, me["id"], me["id"] if me["role"] == "supplier_parent" else None)
    if err == "not_found":
        raise HTTPException(404, "申请不存在")
    if err == "not_pending":
        raise HTTPException(409, "申请已处理")
    if err == "username_exists":
        raise HTTPException(409, "用户名已存在，无法通过")
    return {"ok": True, "member": store.member_public(row)}


@app.post("/api/member-requests/{rid}/reject")
def member_requests_reject(rid: str, me=Depends(require_member)):
    if me["role"] not in {"admin", "supplier_parent"}:
        raise HTTPException(403, "需要成员管理权限")
    request_row = store.get_member_request(rid)
    if me["role"] == "supplier_parent" and (not request_row or request_row[4] != "supplier_child"):
        raise HTTPException(403, "只能处理供应商子账号申请")
    ok, err = store.reject_member_request(rid, me["id"])
    if err == "not_found":
        raise HTTPException(404, "申请不存在")
    if err == "not_pending":
        raise HTTPException(409, "申请已处理")
    return {"ok": True}


# =========================================================
# 定制创作 · 视频工坊 sidecar
# =========================================================
_VIDEO_PROJECT_INDEX_TTL_SEC = 5.0
_VIDEO_PROJECT_INDEX_CACHE = {}


def _video_workshop_project_index(member_id: str, force: bool = False):
    key = str(member_id or "")
    now = time.monotonic()
    cached = _VIDEO_PROJECT_INDEX_CACHE.get(key)
    if cached and not force and now - cached[0] < _VIDEO_PROJECT_INDEX_TTL_SEC:
        return cached[1]
    index = {}
    for mapped in store.list_custom_projects(key, "video"):
        state = mapped.get("projectState") if isinstance(mapped.get("projectState"), dict) else {}
        workshop_project_id = str(state.get("workshopProjectId") or "").strip()
        if state.get("integration") == "video-workshop" and workshop_project_id:
            index[workshop_project_id] = mapped
    _VIDEO_PROJECT_INDEX_CACHE[key] = (now, index)
    return index


def _video_workshop_preferred_voice(me):
    presets = store.list_voice_presets()
    own = [item for item in presets if item.get("ownerId") == str(me.get("id") or "")]
    selected = (own or presets or [None])[0]
    if selected:
        return {
            "voiceId": str(selected.get("voiceId") or "").strip(),
            "name": str(selected.get("name") or selected.get("voiceId") or "").strip(),
            "source": "designed",
        }
    return {
        "voiceId": str(MINIMAX_VOICE_ID or "").strip(),
        "name": "平台默认音色",
        "source": "system",
    }


def _custom_video_session_member(request: Request):
    token = str(request.cookies.get(VIDEO_WORKSHOP_SESSION_COOKIE) or "").strip()
    if not token:
        token = str(request.headers.get("authorization") or "").replace("Bearer ", "").strip()
    member_id = store.parse_token(token) if token else None
    row = store.get_member(member_id) if member_id else None
    if not row:
        raise HTTPException(401, "视频工坊登录态已过期，请刷新定制创作页面")
    member = store.member_public(row)
    return _require_custom_creator(member)


def _video_workshop_safe_path(root: Path, relative_path: str):
    clean = str(relative_path or "").replace("\\", "/").lstrip("/")
    path = (root / clean).resolve()
    try:
        common = os.path.commonpath((str(root.resolve()), str(path)))
    except ValueError:
        raise HTTPException(400, "视频工坊文件路径无效")
    if common != str(root.resolve()):
        raise HTTPException(400, "视频工坊文件路径无效")
    return path


def _video_workshop_owned_project(me, project_id: str):
    project = _video_workshop_project_index(me["id"]).get(str(project_id or "").strip())
    if not project:
        raise HTTPException(403, "无权访问其他成员的视频工坊项目")
    return project


def _rewrite_video_workshop_urls(value):
    if isinstance(value, list):
        return [_rewrite_video_workshop_urls(item) for item in value]
    if isinstance(value, dict):
        return {key: _rewrite_video_workshop_urls(item) for key, item in value.items()}
    if isinstance(value, str) and value.startswith(("/outputs/", "/uploads/")):
        return "/custom-video" + value
    return value


def _sync_video_workshop_project(me, source):
    mapped, error = store.sync_custom_video_project(me["id"], source)
    if error == "forbidden":
        raise HTTPException(403, "视频工坊项目归属冲突")
    if error or not mapped:
        raise HTTPException(500, "视频工坊项目映射失败")
    _VIDEO_PROJECT_INDEX_CACHE.pop(str(me["id"]), None)
    project = _rewrite_video_workshop_urls(source)
    project["_integration"] = {
        "kind": "video",
        "customProjectId": mapped["id"],
        "workshopProjectId": str(source.get("id") or ""),
        "publishedDeliveryId": str(mapped.get("publishedDeliveryId") or ""),
        "publishedAt": int(mapped.get("publishedAt") or 0),
        "publishedCount": max(0, int(mapped.get("publishedCount") or 0)),
        "publishedVideoOutputs": (
            dict((mapped.get("projectState") or {}).get("publishedVideoOutputs"))
            if isinstance((mapped.get("projectState") or {}).get("publishedVideoOutputs"), dict)
            else {}
        ),
    }
    return project


async def _video_workshop_request(
    request: Request,
    api_path: str,
    *,
    body_override=None,
    params_override=None,
):
    target = VIDEO_WORKSHOP_URL + "/api/" + api_path.lstrip("/")
    body = await request.body() if body_override is None else body_override
    headers = {"Accept": "application/json"}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["Content-Type"] = content_type
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(VIDEO_WORKSHOP_TIMEOUT, connect=8.0),
            trust_env=False,
        ) as client:
            return await client.request(
                request.method,
                target,
                content=body or None,
                params=(list(request.query_params.multi_items()) if params_override is None else params_override),
                headers=headers,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(
            503,
            "视频工坊服务未运行。请启动独立 sidecar（默认 127.0.0.1:8765）后重试："
            + f"{exc.__class__.__name__}",
        )


def _video_workshop_timing(name: str, started: float):
    duration_ms = max(0.0, (time.perf_counter() - started) * 1000)
    safe_name = re.sub(r"[^a-zA-Z0-9_-]", "", str(name or "stage")) or "stage"
    return f'{safe_name};dur={duration_ms:.1f}'


def _video_workshop_json_response(data, status_code=200, server_timing=""):
    headers = dict(NO_CACHE_HEADERS)
    if server_timing:
        headers["Server-Timing"] = server_timing
    return Response(
        content=json.dumps(data, ensure_ascii=False),
        status_code=status_code,
        media_type="application/json",
        headers=headers,
    )


def _video_workshop_index_html():
    index_path = _video_workshop_safe_path(VIDEO_WORKSHOP_WEB_DIR, "index.html")
    if not index_path.is_file():
        raise HTTPException(
            503,
            "视频工坊静态资源不存在，请部署“视频工坊产品试验”目录或设置 VIDEO_WORKSHOP_WEB_DIR",
        )
    html = index_path.read_text("utf-8")
    html = re.sub(
        r"<html\b",
        '<html data-platform-embedded="true"',
        html,
        count=1,
        flags=re.I,
    )
    app_match = re.search(
        r'<script\s+src="(?P<src>/assets/app\.js[^"]*)"\s*></script>',
        html,
        flags=re.I,
    )
    app_src = "/custom-video/assets/app.js"
    if app_match:
        app_src = "/custom-video" + app_match.group("src")
        html = html[:app_match.start()] + html[app_match.end():]
    html = html.replace('="/assets/', '="/custom-video/assets/')
    bootstrap = r"""
    <script>
    (() => {
      const APP_SRC = __APP_SRC__;
      const TOKEN_KEY = "dumate.token";
      const LEGACY_PROJECT_KEY = "xingzhen-video-project";
      const PROJECT_KEY_PREFIX = "xingzhen-video-project:";
      const nativeFetch = window.fetch.bind(window);
      let latestProject = null;

      function fail(message) {
        document.body.innerHTML =
          '<main style="min-height:100vh;display:grid;place-items:center;background:#050505;color:#fff;font:15px system-ui;padding:32px;text-align:center">' +
          '<div><strong style="display:block;font-size:20px;margin-bottom:12px">视频工坊暂不可用</strong><span style="color:#a5a5a5">' +
          String(message || "请刷新后重试") + "</span></div></main>";
      }

      function titleFor(project) {
        const named = String(project?.name || "").trim();
        if (named && named !== "新会话") return named;
        return String(project?.plan?.title || named || "未命名视频").trim();
      }

      function payloadFor(project, selectedOutput) {
        const outputs = Array.isArray(project?.outputs) ? project.outputs : [];
        const preferredRatio = String(project?.plan?.aspect_ratio || "");
        const output = selectedOutput
          || outputs.find(item => String(item?.aspectRatio || "") === preferredRatio)
          || outputs[0]
          || null;
        const url = String(output?.url || output?.downloadUrl || "");
        return {
          kind: "video",
          projectId: String(project?.id || ""),
          title: titleFor(project),
          videoUrl: url,
          url,
          downloadUrl: String(output?.downloadUrl || url),
          aspectRatio: String(output?.aspectRatio || preferredRatio || "9:16"),
          sourceDeliveryId: String(output?.deliveryId || project?.activeDeliveryId || ""),
          sourceOutputId: String(output?.id || ""),
          plan: project?.plan || null,
          project,
          status: String(project?.status || ""),
        };
      }

      function publishProject(project, selectedOutput) {
        if (!project || !project.id) return;
        latestProject = project;
        const payload = payloadFor(project, selectedOutput);
        window.parent.postMessage(
          { type: "custom-video:project", project, payload },
          window.location.origin
        );
        if (payload.videoUrl && project.status === "succeeded") {
          window.parent.postMessage(
            { type: "custom-video:output", payload },
            window.location.origin
          );
        }
      }

      function rewrittenUrl(input) {
        if (typeof input !== "string") return input;
        if (input.startsWith("/api/")) return "/custom-video" + input;
        return input;
      }

      window.fetch = async (input, init = {}) => {
        const response = await nativeFetch(rewrittenUrl(input), {
          ...init,
          credentials: "same-origin",
        });
        try {
          const raw = typeof input === "string" ? input : String(input?.url || "");
          if (/^\/api\/(?:chat|projects(?:\/|$))/.test(raw)) {
            response.clone().json().then(data => {
              if (data && data.id) publishProject(data);
            }).catch(() => {});
          }
        } catch (_) {}
        return response;
      };

      document.addEventListener("click", event => {
        const button = event.target.closest?.("#outputTabs button");
        if (!button || !latestProject) return;
        window.setTimeout(() => {
          const buttons = [...document.querySelectorAll("#outputTabs button")];
          const index = Math.max(0, buttons.indexOf(button));
          publishProject(latestProject, latestProject.outputs?.[index]);
        }, 0);
      });

      async function boot() {
        const token = String(localStorage.getItem(TOKEN_KEY) || "");
        if (!token) {
          fail("主平台登录已失效，请返回首页重新登录。");
          return;
        }
        let sessionResponse;
        try {
          sessionResponse = await nativeFetch("/api/custom-video/session", {
            method: "POST",
            headers: { Authorization: "Bearer " + token },
            credentials: "same-origin",
            cache: "no-store",
          });
        } catch (_) {
          fail("无法建立主平台会话，请检查本地服务。");
          return;
        }
        const session = await sessionResponse.json().catch(() => ({}));
        if (!sessionResponse.ok) {
          fail(session.detail || "无权使用定制创作。");
          return;
        }
        const allowed = new Set(Array.isArray(session.allowedProjectIds) ? session.allowedProjectIds : []);
        const projectKey = PROJECT_KEY_PREFIX + String(session.memberId || "");
        window.__XINGZHEN_VIDEO_PROJECT_KEY__ = projectKey;
        let savedProjectId = String(localStorage.getItem(projectKey) || "");
        const legacyProjectId = String(localStorage.getItem(LEGACY_PROJECT_KEY) || "");
        if (!savedProjectId && legacyProjectId && allowed.has(legacyProjectId)) {
          localStorage.setItem(projectKey, legacyProjectId);
          savedProjectId = legacyProjectId;
        }
        localStorage.removeItem(LEGACY_PROJECT_KEY);
        if (savedProjectId && !allowed.has(savedProjectId)) {
          localStorage.removeItem(projectKey);
        }
        window.parent.postMessage({ type: "custom-video:ready" }, window.location.origin);
        const script = document.createElement("script");
        script.src = APP_SRC;
        script.onerror = () => fail("视频工坊脚本加载失败。");
        document.body.append(script);
      }

      boot();
    })();
    </script>
    """.replace("__APP_SRC__", json.dumps(app_src))
    return html.replace("</body>", bootstrap + "\n  </body>")


@app.post("/api/custom-video/session")
def custom_video_session(request: Request, me=Depends(require_member)):
    started = time.perf_counter()
    _require_custom_creator(me)
    token = str(request.headers.get("authorization") or "").replace("Bearer ", "").strip()
    if not token or store.parse_token(token) != me["id"]:
        raise HTTPException(401, "主平台登录态无效")
    allowed_project_ids = list(_video_workshop_project_index(me["id"]).keys())
    response = _video_workshop_json_response({
        "ok": True,
        "memberId": me["id"],
        "allowedProjectIds": allowed_project_ids,
        "preferredVoice": _video_workshop_preferred_voice(me),
    }, server_timing=_video_workshop_timing("session", started))
    response.set_cookie(
        VIDEO_WORKSHOP_SESSION_COOKIE,
        token,
        max_age=store.TOKEN_TTL,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        path="/custom-video",
    )
    return response


@app.get("/custom-video")
@app.get("/custom-video/")
def custom_video_index():
    started = time.perf_counter()
    return Response(
        content=_video_workshop_index_html(),
        media_type="text/html",
        headers={**NO_CACHE_HEADERS, "Server-Timing": _video_workshop_timing("shell", started)},
    )


@app.get("/custom-video/assets/{asset_path:path}")
def custom_video_asset(asset_path: str, request: Request):
    started = time.perf_counter()
    path = _video_workshop_safe_path(VIDEO_WORKSHOP_WEB_DIR / "assets", asset_path)
    if not path.is_file():
        raise HTTPException(404, "视频工坊静态资源不存在")
    response = version_aware_static_file(path, request)
    response.headers["Server-Timing"] = _video_workshop_timing("static", started)
    return response


@app.get("/custom-video/outputs/{file_path:path}")
def custom_video_output(file_path: str, request: Request, me=Depends(_custom_video_session_member)):
    parts = Path(str(file_path or "")).parts
    if len(parts) < 2:
        raise HTTPException(404, "视频成片不存在")
    _video_workshop_owned_project(me, parts[0])
    path = _video_workshop_safe_path(VIDEO_WORKSHOP_OUTPUT_DIR, file_path)
    if not path.is_file():
        raise HTTPException(404, "视频成片不存在或已被清理")
    return ranged_file_response(request, path, media_type=_media_type_for_path(path), cache_seconds=300)


@app.get("/custom-video/uploads/{file_path:path}")
def custom_video_upload(file_path: str, request: Request, me=Depends(_custom_video_session_member)):
    parts = Path(str(file_path or "")).parts
    if len(parts) < 2:
        raise HTTPException(404, "视频工坊附件不存在")
    _video_workshop_owned_project(me, parts[0])
    path = _video_workshop_safe_path(VIDEO_WORKSHOP_UPLOAD_DIR, file_path)
    if not path.is_file():
        raise HTTPException(404, "视频工坊附件不存在或已被清理")
    return ranged_file_response(request, path, media_type=_media_type_for_path(path), cache_seconds=300)


@app.api_route(
    "/custom-video/api/{api_path:path}",
    methods=["GET", "POST", "PATCH"],
)
async def custom_video_api(api_path: str, request: Request, me=Depends(_custom_video_session_member)):
    started = time.perf_counter()
    path = str(api_path or "").strip("/")
    method = request.method.upper()
    if path == "health" and method == "GET":
        upstream = await _video_workshop_request(request, path)
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type="application/json",
            headers={**NO_CACHE_HEADERS, "Server-Timing": _video_workshop_timing("health", started)},
        )
    if path == "projects" and method == "GET":
        mapped_projects = _video_workshop_project_index(me["id"])
        allowed_ids = sorted(mapped_projects)
        if not allowed_ids:
            page = max(1, int(request.query_params.get("page") or 1))
            page_size = max(1, min(100, int(request.query_params.get("pageSize") or 60)))
            return _video_workshop_json_response({
                "items": [], "total": 0, "page": page, "pageSize": page_size, "hasMore": False,
            }, server_timing=_video_workshop_timing("projects", started))
        params = [
            (key, value)
            for key, value in request.query_params.multi_items()
            if key != "projectIds"
        ]
        params.append(("projectIds", ",".join(allowed_ids)))
        upstream = await _video_workshop_request(request, path, params_override=params)
        if upstream.status_code >= 400:
            return Response(content=upstream.content, status_code=upstream.status_code, media_type="application/json")
        try:
            data = upstream.json()
        except Exception:
            raise HTTPException(502, "视频工坊项目列表返回异常")
        visible_items = []
        for raw_item in data.get("items") or []:
            if not isinstance(raw_item, dict):
                continue
            project_id = str(raw_item.get("id") or "").strip()
            mapped = mapped_projects.get(project_id)
            if not mapped:
                continue
            item = _rewrite_video_workshop_urls(raw_item)
            item["_integration"] = {
                "kind": "video",
                "customProjectId": str(mapped.get("id") or ""),
                "workshopProjectId": project_id,
                "publishedDeliveryId": str(mapped.get("publishedDeliveryId") or ""),
                "publishedAt": int(mapped.get("publishedAt") or 0),
                "publishedCount": max(0, int(mapped.get("publishedCount") or 0)),
                "publishedVideoOutputs": (
                    dict((mapped.get("projectState") or {}).get("publishedVideoOutputs"))
                    if isinstance((mapped.get("projectState") or {}).get("publishedVideoOutputs"), dict)
                    else {}
                ),
            }
            visible_items.append(item)
        data["items"] = visible_items
        return _video_workshop_json_response(
            data,
            server_timing=_video_workshop_timing("projects", started),
        )

    project_match = re.fullmatch(r"projects/([^/]+)(?:/(retry|cancel))?", path)
    if project_match:
        project_id = project_match.group(1)
        _video_workshop_owned_project(me, project_id)
        upstream = await _video_workshop_request(request, path)
        if upstream.status_code >= 400:
            return Response(content=upstream.content, status_code=upstream.status_code, media_type="application/json")
        try:
            project = upstream.json()
        except Exception:
            raise HTTPException(502, "视频工坊项目返回异常")
        return _video_workshop_json_response(
            _sync_video_workshop_project(me, project),
            server_timing=_video_workshop_timing("project", started),
        )

    if path == "chat" and method == "POST":
        try:
            payload = json.loads((await request.body()).decode("utf-8"))
        except Exception:
            raise HTTPException(400, "视频工坊请求体不是合法 JSON")
        existing_project_id = str(payload.get("projectId") or "").strip()
        if existing_project_id:
            _video_workshop_owned_project(me, existing_project_id)
        if not str(payload.get("voiceId") or "").strip():
            payload["voiceId"] = _video_workshop_preferred_voice(me)["voiceId"]
        upstream = await _video_workshop_request(
            request,
            path,
            body_override=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        )
        if upstream.status_code >= 400:
            return Response(content=upstream.content, status_code=upstream.status_code, media_type="application/json")
        try:
            project = upstream.json()
        except Exception:
            raise HTTPException(502, "视频工坊导演返回异常")
        return _video_workshop_json_response(_sync_video_workshop_project(me, project))

    raise HTTPException(404, "该视频工坊接口未开放给主平台")


# ---------- 前端静态资源（仅暴露必要文件，不整目录托管，避免泄露 _backup_*/源码/方案文档） ----------
app.mount("/js", VersionAwareStaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")
app.mount("/styles", VersionAwareStaticFiles(directory=str(FRONTEND_DIR / "styles")), name="styles")
app.mount("/assets", VersionAwareStaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")
if CUSTOM_CANVAS_DIR.is_dir():
    app.mount(
        "/XZ-Design",
        VersionAwareStaticFiles(directory=str(CUSTOM_CANVAS_DIR), html=True),
        name="infinite-canvas",
    )


@app.get("/")
def index():
    return no_cache_file(FRONTEND_DIR / "index.html")


@app.head("/")
def index_head():
    return Response(status_code=200, headers=NO_CACHE_HEADERS)


@app.get("/index.html")
def index_html():
    return no_cache_file(FRONTEND_DIR / "index.html")


@app.head("/index.html")
def index_html_head():
    return Response(status_code=200, headers=NO_CACHE_HEADERS)


@app.get("/favicon.svg")
def favicon():
    return no_cache_file(FRONTEND_DIR / "assets" / "brand" / "xingzhen-favicon.png", media_type="image/png")


@app.get("/favicon.ico")
def favicon_ico():
    return no_cache_file(FRONTEND_DIR / "assets" / "brand" / "xingzhen-favicon.png", media_type="image/png")


@app.get("/logo.png")
def logo():
    return no_cache_file(FRONTEND_DIR / "logo.png", media_type="image/png")
