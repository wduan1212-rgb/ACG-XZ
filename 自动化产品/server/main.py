# =========================================================
# ACG 视频工具 · 最小可运行后端（FastAPI）
# 作用：
#   1. 托管前端静态页（index.html + js/ ES Modules + styles/ 分仓 CSS）
#   2. /api/llm 转发 DeepSeek 等模型请求（解决 CORS + 隐藏 Key）
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
import base64
import asyncio
import socket
import shutil
import subprocess
import tempfile
import mimetypes
import io
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Request, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

try:
    from PIL import Image, ImageOps, ImageEnhance
except Exception:  # Pillow is optional; image generation still works without post-normalization.
    Image = None
    ImageOps = None
    ImageEnhance = None

try:
    from . import store
except ImportError:  # 兼容以脚本方式直接运行
    import store

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT.parent          # index.html 所在目录
DATA_FILE = Path(os.getenv("LEGACY_DATA_FILE", ROOT / "data.json"))
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", ROOT / "uploads"))


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

LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_ENDPOINT = os.getenv("LLM_ENDPOINT", (LLM_BASE_URL + "/v1/chat/completions") if LLM_BASE_URL else "https://api.deepseek.com/chat/completions")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-chat")
LLM_FORCE_MODEL = os.getenv("LLM_FORCE_MODEL", "true").lower() not in {"0", "false", "no"}
LLM_THINKING = os.getenv("LLM_THINKING", "").strip().lower()
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "0") or "0")
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "120"))
LLM_CONNECT_TIMEOUT = float(os.getenv("LLM_CONNECT_TIMEOUT", "12"))
JUSTONEAPI_KEY = os.getenv("JUSTONEAPI_KEY", "")
JUSTONEAPI_BASE_URL = os.getenv("JUSTONEAPI_BASE_URL", "https://api.justoneapi.com").rstrip("/")
SEEDANCE_API_KEY = os.getenv("SEEDANCE_API_KEY", "") or os.getenv("SEEDANCE_KEY", "")
SEEDANCE_BASE_URL = (os.getenv("SEEDANCE_BASE_URL") or os.getenv("LLMONE_BASE_URL") or "https://api.llmone.ai").rstrip("/")
SEEDANCE_MODEL = os.getenv("SEEDANCE_MODEL", "doubao-seedance-2-0-fast-260128")
SEEDANCE_RESOLUTION = os.getenv("SEEDANCE_RESOLUTION", "720p")
SEEDANCE_GENERATE_AUDIO = os.getenv("SEEDANCE_GENERATE_AUDIO", "").lower() in {"1", "true", "yes"}
SEEDANCE_WATERMARK = os.getenv("SEEDANCE_WATERMARK", "").lower() in {"1", "true", "yes"}
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
VIDEO_REFS = {}
COMPOSED_DIR = Path(os.getenv("COMPOSED_DIR", ROOT / "composed"))
MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY", "")
MINIMAX_BASE_URL = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com").rstrip("/")
MINIMAX_GROUP_ID = os.getenv("MINIMAX_GROUP_ID", "").strip()
MINIMAX_TTS_MODEL = os.getenv("MINIMAX_TTS_MODEL", "speech-2.8-hd")
MINIMAX_VOICE_ID = os.getenv("MINIMAX_VOICE_ID", "presenter_female")
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

app = FastAPI(title="ACG 视频工具 API", version="0.1.0",
              description="账号化 AI 视频生产工作台后端。CLI / agent 可直接按本 OpenAPI 调用。")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return response


NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
}


def no_cache_file(path: Path, media_type: str = None):
    return FileResponse(str(path), media_type=media_type, headers={
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache"
    })


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


async def _call_llm(body: dict, auth_header: str = ""):
    if LLM_FORCE_MODEL and LLM_MODEL:
        body["model"] = LLM_MODEL
    if LLM_THINKING in {"enabled", "disabled"} and "thinking" not in body:
        body["thinking"] = {"type": LLM_THINKING}
    if LLM_MAX_TOKENS > 0 and "max_tokens" not in body:
        body["max_tokens"] = LLM_MAX_TOKENS
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(LLM_TIMEOUT, connect=LLM_CONNECT_TIMEOUT), trust_env=False) as client:
            return await client.post(LLM_ENDPOINT, json=body, headers=_llm_headers(auth_header))
    except httpx.HTTPError as exc:
        raise _llm_error(502, f"{exc.__class__.__name__}: {exc}")


class LLMReq(BaseModel):
    messages: list
    json_mode: bool = False
    temperature: float = 0.7


class XhsTrendReq(BaseModel):
    query: str = ""
    limit: int = 8


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
    endpoint: str = ""
    model: str = ""
    apiKey: str = ""


def _clean_image_endpoint(endpoint: str = "") -> str:
    endpoint = (endpoint or "").strip()
    if not endpoint:
        return ""
    if endpoint.startswith("/api/image") or endpoint.startswith("/api/"):
        return ""
    return endpoint


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


def _image_from_response(data: dict) -> str:
    item = ((data.get("data") or [{}])[0] if isinstance(data.get("data"), list) else {}) or \
        ((data.get("images") or [{}])[0] if isinstance(data.get("images"), list) else {}) or \
        _deep_get(data, ("result", "data", 0), default={}) or {}
    b64 = item.get("b64_json") or item.get("b64") or item.get("base64") or data.get("b64_json")
    if b64:
        return b64 if str(b64).startswith("data:image/") else "data:image/png;base64," + str(b64)
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
        im = Image.open(BytesIO(blob))
        im = ImageOps.exif_transpose(im) if ImageOps else im
        im = im.convert("RGB")
        if ImageEnhance:
            im = ImageEnhance.Color(im).enhance(1.03)
            im = ImageEnhance.Contrast(im).enhance(1.02)
            im = ImageEnhance.Sharpness(im).enhance(1.02)
        out = BytesIO()
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
            allow_redirects=True,
        )
    try:
        if getattr(client, "is_closed", False):
            async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=12.0), trust_env=False) as fresh:
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
        "response_format": "url",
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


async def _post_json_with_retry(client: httpx.AsyncClient, endpoint: str, body: dict, headers: dict, retries: int = 8):
    last_r = None
    last_data = None
    for attempt in range(retries + 1):
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
                r = await client.get(url, timeout=httpx.Timeout(60.0, connect=8.0))
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


@app.get("/api/llm/config")
def llm_config():
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
async def llm_test():
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
    content = _deep_get(data, ("choices", 0, "message", "content"), default="")
    return {"ok": True, "model": LLM_MODEL, "content": content, "endpoint": _mask_endpoint(LLM_ENDPOINT)}


@app.post("/api/llm")
async def llm_proxy(req: LLMReq):
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
    return {"content": r.json()["choices"][0]["message"]["content"]}


def _parse_xhs_opencli_yaml(text: str, limit: int = 8) -> List[Dict]:
    items: List[Dict] = []
    current: Dict[str, str] = {}
    key_re = re.compile(r"^\s*(?:-\s*)?(rank|title|note_title|likes|published_at|author|url|desc|description|summary|content|text)\s*:\s*(.*)\s*$", re.I)
    for line in (text or "").splitlines():
        m = key_re.match(line)
        if not m:
            continue
        key = m.group(1).lower()
        value = m.group(2).strip().strip('"').strip("'")
        if key == "rank" and current.get("title"):
            items.append(current)
            current = {}
        current[key] = value
    if current.get("title"):
        items.append(current)
    clean = []
    for item in items:
        title = re.sub(r"\s+", " ", item.get("title") or item.get("note_title") or "").strip()
        if not title:
            continue
        desc = re.sub(r"\s+", " ", item.get("desc") or item.get("description") or item.get("summary") or item.get("content") or item.get("text") or "").strip()
        clean.append({
            "title": title[:80],
            "desc": desc[:800],
            "likes": item.get("likes", ""),
            "author": item.get("author", ""),
            "url": item.get("url", "")
        })
        if len(clean) >= limit:
            break
    return clean


@app.post("/api/research/xhs-trends")
async def xhs_trends(req: XhsTrendReq):
    """可选联网趋势参考。失败时前端回退本地趋势库，不阻塞创作链路。"""
    query = re.sub(r"\s+", " ", (req.query or "")).strip()[:90]
    limit = max(1, min(12, int(req.limit or 8)))
    if not query:
        return {"ok": False, "items": [], "reason": "missing_query"}
    if os.getenv("XHS_TREND_SEARCH", "auto").lower() in {"0", "false", "off", "no"}:
        return {"ok": False, "items": [], "reason": "disabled"}
    if not shutil.which("opencli"):
        return {
            "ok": False,
            "items": [],
            "reason": "opencli_missing",
            "message": "服务器进程未检测到 OpenCLI 命令。本地浏览器已配置不等于线上可用；请在服务器运行环境安装 OpenCLI 并确认服务进程 PATH 可见，本次已自动回退本地趋势库。"
        }
    try:
        run = subprocess.run(
            ["opencli", "xiaohongshu", "search", query, "-f", "yaml"],
            cwd=str(FRONTEND_DIR),
            capture_output=True,
            text=True,
            timeout=35,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "items": [], "reason": "timeout", "message": "小红书趋势搜索超时，已回退本地趋势库。"}
    if run.returncode != 0:
        raw = (run.stderr or run.stdout or "").lower()
        reason = "auth_required" if any(x in raw for x in ("auth", "login", "登录", "token", "cookie")) else "opencli_failed"
        message = "小红书联网参考暂不可用。请确认服务器 OpenCLI 可执行、已完成小红书登录态授权，且服务进程能读取同一份配置；本次已自动回退本地趋势库。"
        return {"ok": False, "items": [], "reason": reason, "message": message}
    return {"ok": True, "provider": "opencli", "query": query, "items": _parse_xhs_opencli_yaml(run.stdout, limit)}


@app.post("/api/chat/completions")
async def chat_completions_proxy(req: Request):
    """OpenAI 兼容透传：前端语言模型 Provider 指到这里即可，免浏览器跨域、Key 藏服务器。
    请求体原样转发到 LLM_ENDPOINT，响应原样返回（保留 choices 结构供前端解析）。
    优先用服务器环境变量 LLM_API_KEY（隐藏真实 Key）；未配置时回退请求头 Authorization（仅解决 CORS）。"""
    raw = await req.body()
    auth = f"Bearer {LLM_API_KEY}" if LLM_API_KEY else req.headers.get("authorization", "")
    if not auth:
        raise HTTPException(500, "服务器未配置 LLM_API_KEY，且请求未携带 Authorization")
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
def image_config():
    endpoint = _image_endpoint()
    reachable, detail = _resolve_base(endpoint)
    return {
        "ok": True,
        "configured": bool(IMAGE_API_KEY),
        "reachable": reachable,
        "detail": detail,
        "model": IMAGE_MODEL,
        "mode": (
            "responses" if _image_is_responses_mode(endpoint=endpoint)
            else ("chat" if _image_is_chat_mode(endpoint=endpoint)
                  else ("gpt-maas" if _image_is_maas_mode(endpoint=endpoint) else "images"))
        ),
        "endpoint": _mask_endpoint(endpoint),
        "baseUrl": _public_base(endpoint),
    }


@app.post("/api/image/generate")
async def image_generate(req: ImageGenerateReq):
    """同源图片生成代理：解决浏览器跨域，并保留最多 5 张参考图。
    本地测试可以由前端传 apiKey；服务器部署建议只配置 IMAGE_API_KEY。"""
    api_key = req.apiKey or IMAGE_API_KEY
    if not api_key:
        raise HTTPException(500, "服务器未配置图片 API Key")
    raw_prompt = (req.prompt or "").strip()
    if not raw_prompt:
        raise HTTPException(400, "图片提示词为空")
    prompt = _guard_image_prompt(raw_prompt)
    ratio = _infer_image_ratio_from_prompt(raw_prompt, _normalize_image_ratio(req.ratio))
    endpoint = _image_endpoint(req.endpoint)
    edit_endpoint = _image_edit_endpoint(req.endpoint)
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
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=12.0), trust_env=False) as client:
            ref_files = await _collect_image_ref_files(client, req.refs or [])
            skipped_refs = max(0, len(req.refs or []) - len(ref_files))
            if maas_mode:
                used_refs = min(len(ref_files), 8)
                maas_prompt = prompt
                if used_refs:
                    maas_prompt += "\n\n参考随消息附带的 %d 张参考图；以本次提示词的主题和文字内容为准。" % used_refs
                maas_model = _maas_model_for_refs(req.model or model, bool(ref_files))
                maas_body = _maas_image_body(maas_prompt, maas_model, ratio, ref_files)
                r, data = await _post_json_with_retry(client, endpoint, maas_body, json_headers)
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
                r = await client.post(edit_endpoint, data=form, files=file_parts, headers=upload_headers)
                data = r.json() if "json" in (r.headers.get("content-type") or "") else {}
                if r.status_code >= 400:
                    file_parts = [("image[]", (name, blob, mime)) for name, blob, mime in ref_files]
                    r = await client.post(edit_endpoint, data=form, files=file_parts, headers=upload_headers)
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
        raise HTTPException(502, "无法连接图片 API（%s）：%s %s" % (_public_base(endpoint), exc.__class__.__name__, exc))
    except Exception as exc:
        raise HTTPException(502, "图片 API 适配失败：%s %s" % (exc.__class__.__name__, str(exc)[:240]))
    if r.status_code >= 400:
        detail = _http_detail(data) if data else r.text[:1000]
        raise HTTPException(r.status_code, detail or "图片生成失败")
    if isinstance(data, dict) and (data.get("error") or str(data.get("status") or "").lower() == "failed"):
        detail = _http_detail(data) or "图片生成失败"
        raise HTTPException(502, detail)
    try:
        output = _find_image_url_or_data(data) if responses_mode else (_image_from_chat_response(data) if chat_mode else _image_from_response(data))
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


class ComposeReq(BaseModel):
    clips: List[ComposeClip]
    title: str = "final"
    narrationUrl: str = ""
    narrationDataUrl: str = ""
    bgmUrl: str = ""
    bgmDataUrl: str = ""
    bgmVolume: float = 0.25


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


@app.get("/api/video/config")
def video_config():
    reachable, detail = _resolve_base(SEEDANCE_BASE_URL)
    return {
        "ok": True,
        "provider": "seedance",
        "configured": bool(SEEDANCE_API_KEY),
        "reachable": reachable,
        "detail": detail,
        "model": SEEDANCE_MODEL,
        "baseUrl": _public_base(SEEDANCE_BASE_URL),
    }


@app.get("/api/video/ref/{rid}")
def video_ref(rid: str):
    item = VIDEO_REFS.get(rid)
    if not item:
        raise HTTPException(404, "reference image not found")
    mime, data, _ = item
    return Response(content=data, media_type=mime, headers={"Cache-Control": "no-store"})


@app.post("/api/video/submit")
async def video_submit(req: VideoSubmitReq):
    if not SEEDANCE_API_KEY:
        raise HTTPException(500, "服务器未配置 SEEDANCE_API_KEY")
    resolved_images = []
    resolved_audios = []
    ignored_local_audios = []
    unresolved_local_images = []
    for i, ref in enumerate((req.refs or [])[:9]):
        kind = _ref_kind(ref)
        url = _ref_url(ref)
        if url and kind == "audio" and url.startswith("data:"):
            ignored_local_audios.append(ref.name or f"音频{i + 1}")
        elif url and kind == "audio":
            resolved_audios.append((i, ref, url))
        elif url and kind == "image":
            resolved_images.append((i, ref, url))
        elif ref.dataUrl and kind == "audio":
            ignored_local_audios.append(ref.name or f"音频{i + 1}")
        elif ref.dataUrl or (ref.url or "").startswith(("http://localhost", "https://localhost", "http://127.0.0.1", "https://127.0.0.1")):
            unresolved_local_images.append(ref.name or f"图{i + 1}")
    if unresolved_local_images:
        # 本地调试时 localhost/dataURL 参考图无法被 Seedance 上游读取。图片参考降级为纯文本生成，
        # 避免卡死创作；音频参考仍需真实可访问 URL，因为它会影响生成声音。
        pass
    ref_parts = []
    if resolved_images:
        ref_parts.append(f"请参考{'、'.join(f'[图{i + 1}]' for i, _, _ in resolved_images)}，并保持主体、界面和画面结构信息一致。")
    if unresolved_local_images:
        ref_parts.append("部分本地参考图当前无法被上游读取，本次按文本提示词生成；部署到有 PUBLIC_BASE_URL 的服务器后可自动携带参考图。")
    if resolved_audios:
        ref_parts.append(f"请参考{'、'.join(f'[音频{i + 1}]' for i, _, _ in resolved_audios)}的声线、音色、语气和语速生成视频口播；口播内容以文本提示词为准，不生成字幕。")
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
    for i, ref, url in resolved_audios:
        content.append({"type": "audio_url", "audio_url": {"url": url}, "role": "reference_audio"})
    payload = {
        "model": req.model or SEEDANCE_MODEL,
        "prompt": "",
        "metadata": {
            "content": content,
            "ratio": req.ratio or "9:16",
            "duration": max(4, min(15, int(req.duration or 15))),
            "resolution": req.resolution or SEEDANCE_RESOLUTION,
            "watermark": SEEDANCE_WATERMARK,
            "generate_audio": SEEDANCE_GENERATE_AUDIO if req.generateAudio is None else req.generateAudio,
            "return_last_frame": True,
            "seed": -1,
        },
    }
    headers = {
        "Authorization": f"Bearer {SEEDANCE_API_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "identity",
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=8.0), trust_env=False) as client:
            r = await client.post(f"{SEEDANCE_BASE_URL}/v1/video/generations", json=payload, headers=headers)
            if r.status_code >= 400 and resolved_images:
                try:
                    err_text = json.dumps(r.json(), ensure_ascii=False)
                except Exception:
                    err_text = r.text[:1200]
                low = err_text.lower()
                if "image_url" in low and ("timeout while fetching" in low or "fetching resource" in low or "not valid" in low):
                    fallback_payload = dict(payload)
                    fallback_meta = dict(payload.get("metadata") or {})
                    fallback_meta["content"] = [{
                        "type": "text",
                        "text": (
                            "参考图当前无法被 Seedance 上游读取，本次自动降级为纯文本生成；"
                            "请按提示词里的文字描述完成画面，不要因为参考图不可读而失败。\n"
                            + req.prompt.strip()
                        ),
                    }]
                    fallback_payload["metadata"] = fallback_meta
                    r = await client.post(f"{SEEDANCE_BASE_URL}/v1/video/generations", json=fallback_payload, headers=headers)
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
    provider_ref = data.get("id") or data.get("task_id") or data.get("taskId") or (data.get("data") or {}).get("id") or (data.get("data") or {}).get("task_id")
    if not provider_ref:
        raise HTTPException(502, {"detail": "Seedance 已返回结果，但没有任务 ID；请检查模型/接口返回结构。", "raw": data})
    return {"ok": True, "providerRef": provider_ref, "raw": data}


@app.get("/api/video/poll/{task_id}")
async def video_poll(task_id: str):
    if not SEEDANCE_API_KEY:
        raise HTTPException(500, "服务器未配置 SEEDANCE_API_KEY")
    headers = {"Authorization": f"Bearer {SEEDANCE_API_KEY}", "Accept": "application/json", "Accept-Encoding": "identity"}
    async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
        r = await client.get(f"{SEEDANCE_BASE_URL}/v1/video/generations/{task_id}", headers=headers)
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
    return {
        "ok": True,
        "status": status,
        "progress": _video_progress(data, status),
        "output": {"url": video_url, "label": "Seedance 片段已生成"} if video_url else None,
        "error": _video_error(data) if status == "failed" else None,
        "raw": data,
    }


@app.post("/api/video/cancel/{task_id}")
async def video_cancel(task_id: str):
    if SEEDANCE_API_KEY:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            await client.delete(f"{SEEDANCE_BASE_URL}/v1/video/generations/{task_id}",
                                headers={"Authorization": f"Bearer {SEEDANCE_API_KEY}"})
    return {"ok": True}


@app.post("/api/proxy/file")
async def proxy_file(req: FileProxyReq):
    """把远端生成结果转成同源下载，供前端打包 ZIP 使用。"""
    url = (req.url or "").strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http/https 文件地址")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=12.0), trust_env=False) as client:
            r = await client.get(url, allow_redirects=True)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"远端文件下载失败：{exc.__class__.__name__} {exc}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, r.text[:300] or "远端文件下载失败")
    media = r.headers.get("content-type", "application/octet-stream").split(";")[0]
    return Response(content=r.content, media_type=media)


@app.get("/api/video/composed/{name}")
def composed_file(name: str):
    path = COMPOSED_DIR / name
    if not path.exists():
        raise HTTPException(404, "成片不存在")
    return FileResponse(path, media_type="video/mp4", filename=name)


@app.post("/api/video/compose")
async def video_compose(req: ComposeReq):
    """把时间轴上的 Seedance 片段拼成一个同源 mp4。
    本地/服务器都需要安装 ffmpeg；支持把口播与 BGM 混进成片。"""
    ffmpeg = _ffmpeg_bin()
    if not ffmpeg:
        raise HTTPException(501, "本机未安装 ffmpeg，无法合成成片。服务器部署时请安装 ffmpeg 后再使用 /api/video/compose。")
    clips = [c for c in (req.clips or []) if (c.url or "").startswith(("http://", "https://"))]
    if not clips:
        raise HTTPException(400, "没有可合成的视频片段 URL")
    total_dur = max(0.5, sum(float(c.dur or 0) for c in clips) or (len(clips) * 15))
    COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
    out_name = f"{int(time.time())}_{hashlib.sha1((req.title or 'final').encode('utf-8')).hexdigest()[:8]}.mp4"
    out_path = COMPOSED_DIR / out_name
    with tempfile.TemporaryDirectory() as td:
        tdir = Path(td)
        files = []
        narr_path = tdir / "narration.mp3"
        bgm_path = tdir / "bgm.mp3"
        async with httpx.AsyncClient(timeout=httpx.Timeout(240.0, connect=12.0), trust_env=False) as client:
            for i, c in enumerate(clips):
                r = await client.get(c.url, allow_redirects=True)
                if r.status_code >= 400:
                    raise HTTPException(502, f"下载片段失败：{c.name or i + 1} HTTP {r.status_code}")
                fp = tdir / f"clip_{i:03d}.mp4"
                fp.write_bytes(r.content)
                files.append(fp)
            if req.narrationDataUrl:
                _write_data_url(narr_path, req.narrationDataUrl)
            elif req.narrationUrl and req.narrationUrl.startswith(("http://", "https://")):
                r = await client.get(req.narrationUrl)
                if r.status_code < 400:
                    narr_path.write_bytes(r.content)
            if req.bgmDataUrl:
                _write_data_url(bgm_path, req.bgmDataUrl)
            elif req.bgmUrl and req.bgmUrl.startswith(("http://", "https://")):
                r = await client.get(req.bgmUrl)
                if r.status_code < 400:
                    bgm_path.write_bytes(r.content)
        concat = tdir / "concat.txt"
        lines = []
        for f in files:
            escaped = str(f).replace("'", "'\\''")
            lines.append(f"file '{escaped}'")
        concat.write_text("\n".join(lines), "utf-8")
        base_path = tdir / "base.mp4"
        cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", str(base_path)]
        run = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if run.returncode != 0:
            cmd = [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", str(base_path)]
            run = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if run.returncode != 0 or not base_path.exists():
            raise HTTPException(502, "ffmpeg 合成失败：" + (run.stderr or run.stdout)[-800:])
        has_narr = narr_path.exists() and narr_path.stat().st_size > 0
        has_bgm = bgm_path.exists() and bgm_path.stat().st_size > 0
        if not has_narr and not has_bgm:
            shutil.copyfile(base_path, out_path)
        else:
            vol = max(0.05, min(0.6, float(req.bgmVolume or 0.25)))
            audio_cmd = [ffmpeg, "-y", "-i", str(base_path)]
            if has_narr:
                audio_cmd += ["-i", str(narr_path)]
            if has_bgm:
                audio_cmd += ["-i", str(bgm_path)]
            if has_narr and has_bgm:
                audio_cmd += [
                    "-filter_complex",
                    f"[1:a]volume=1.0[a1];[2:a]volume={vol}[a2];[a1][a2]amix=inputs=2:duration=shortest:dropout_transition=0[a]",
                    "-map", "0:v:0", "-map", "[a]"
                ]
            elif has_narr:
                audio_cmd += ["-map", "0:v:0", "-map", "1:a:0"]
            else:
                audio_cmd += ["-map", "0:v:0", "-map", "1:a:0", "-filter:a", f"volume={vol}"]
            audio_cmd += ["-c:v", "copy", "-c:a", "aac", "-shortest", "-t", f"{total_dur:.3f}", "-movflags", "+faststart", str(out_path)]
            run = subprocess.run(audio_cmd, capture_output=True, text=True, timeout=900)
            if run.returncode != 0 or not out_path.exists():
                raise HTTPException(502, "ffmpeg 混音失败：" + (run.stderr or run.stdout)[-800:])
    return {"ok": True, "url": f"/api/video/composed/{out_name}", "name": out_name}


# ---------- TTS 代理：MiniMax ----------
class TtsReq(BaseModel):
    text: str
    voiceId: str = ""
    speed: float = 1
    vol: float = 1
    pitch: float = 0
    languageBoost: str = "auto"


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


def _minimax_connect_error(exc: Exception) -> str:
    return (
        "无法连接 Minimax TTS endpoint（%s）：%s %s。"
        "这是服务器到上游的网络/域名/代理问题，不是 voice_id 无效；"
        "如果部署在 BCC，请改用可访问的内网 Minimax 网关或配置可用代理。"
    ) % (_public_base(MINIMAX_BASE_URL), exc.__class__.__name__, exc)


def _tts_payload(text: str, voice_id: str, speed=1, vol=1, pitch=0, language_boost="auto"):
    return {
        "model": MINIMAX_TTS_MODEL,
        "text": (text or "")[:9999],
        "stream": False,
        "language_boost": language_boost or "auto",
        "output_format": "hex",
        "voice_setting": {
            "voice_id": voice_id,
            "speed": _int_if_whole(speed, 1),
            "vol": int(round(float(vol or 1))),
            "pitch": int(round(float(pitch or 0))),
        },
        "audio_setting": {"sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1},
    }


def _audio_data_url_from_minimax(data: dict) -> str:
    audio = ((data.get("data") or {}).get("audio") or data.get("audio") or "")
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


@app.get("/api/tts/config")
def tts_config():
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
async def tts_test():
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
        if _looks_like_voice_error(detail):
            raise HTTPException(400, "默认 Minimax voice_id 无效或不存在：" + detail[:500])
        raise HTTPException(r.status_code, detail)
    data = r.json()
    base = data.get("base_resp") or {}
    if base.get("status_code", 0) != 0:
        msg = base.get("status_msg") or "Minimax TTS 测试失败"
        if _looks_like_voice_error(msg):
            raise HTTPException(400, "默认 Minimax voice_id 无效或不存在：" + msg[:500])
        raise HTTPException(502, msg)
    return {"ok": True, "provider": "minimax", "model": MINIMAX_TTS_MODEL, "voiceId": MINIMAX_VOICE_ID}


@app.get("/api/tts/voice/lookup")
async def tts_voice_lookup(voiceId: str = "", test: bool = True):
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
        msg = base.get("status_msg") or "Minimax TTS 声线测试失败"
        result["valid"] = False if _looks_like_voice_error(msg) else None
        result["detail"] = msg
        return result
    result["valid"] = True
    result["durationMs"] = int((data.get("extra_info") or {}).get("audio_length") or 0)
    return result


@app.post("/api/tts/generate")
async def tts_generate(req: TtsReq):
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
                raise HTTPException(r.status_code, detail)
            data = r.json()
            base = data.get("base_resp") or {}
            voice_id = MINIMAX_VOICE_ID
        else:
            raise HTTPException(r.status_code, detail)
    else:
        data = r.json()
        base = data.get("base_resp") or {}
    if base.get("status_code", 0) != 0:
        msg = base.get("status_msg") or "Minimax TTS 生成失败"
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
            raise HTTPException(502, base.get("status_msg") or msg)
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
def list_accounts():
    return load_db()["accounts"]


@app.post("/api/accounts")
def create_account(acc: Account):
    db = load_db()
    item = {"id": uuid.uuid4().hex[:8], "createdAt": int(time.time()),
            "monthlyDone": 0, "assets": [], **acc.dict()}
    db["accounts"].append(item)
    save_db(db)
    return item


@app.delete("/api/accounts/{acc_id}")
def delete_account(acc_id: str):
    db = load_db()
    before = len(db["accounts"])
    db["accounts"] = [a for a in db["accounts"] if a["id"] != acc_id]
    if len(db["accounts"]) == before:
        raise HTTPException(404, "账号不存在")
    save_db(db)
    return {"ok": True}


# ---------- 素材（供应商端下载的成片） ----------
class Asset(BaseModel):
    name: str
    accountId: str
    type: str = "视频"
    tags: List[str] = []
    url: Optional[str] = None      # 对象存储地址（BOS/OSS/S3）


@app.get("/api/assets")
def list_assets(platform: Optional[str] = None, tag: Optional[str] = None):
    items = load_db()["assets"]
    if platform:
        items = [x for x in items if x.get("platform") == platform]
    if tag:
        items = [x for x in items if tag in x.get("tags", [])]
    return items


@app.post("/api/assets")
def create_asset(asset: Asset):
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
def mark_downloaded(asset_id: str):
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


# ---------- 数据分析：小红书链接解析 / 指标采集 ----------
class AnalyticsResolveReq(BaseModel):
    url: str


class AnalyticsFetchReq(BaseModel):
    url: str
    noteId: Optional[str] = None
    assetId: Optional[str] = None
    accountId: Optional[str] = None
    title: Optional[str] = None


def _note_id(url: str) -> str:
    for mark in ("/explore/", "/discovery/item/", "/item/"):
        if mark in url:
            return url.split(mark, 1)[1].split("?", 1)[0].split("/", 1)[0]
    return "note_" + hashlib.sha1(url.encode("utf-8")).hexdigest()[:8]


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


def _num(value) -> int:
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    s = str(value).replace(",", "").strip().lower()
    mul = 1
    if "万" in s or "w" in s:
        mul = 10000
    digits = "".join(ch for ch in s if ch.isdigit() or ch == ".")
    try:
        return int(float(digits or "0") * mul)
    except ValueError:
        return 0


async def _justone_get(path: str, params: dict) -> dict:
    if not JUSTONEAPI_KEY:
        raise RuntimeError("JUSTONEAPI_KEY not configured")
    q = {"token": JUSTONEAPI_KEY, **{k: v for k, v in params.items() if v not in (None, "")}}
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(JUSTONEAPI_BASE_URL + path, params=q, allow_redirects=True)
    if r.status_code != 200:
        raise RuntimeError(f"JustOneAPI HTTP {r.status_code}: {r.text[:240]}")
    payload = r.json()
    if isinstance(payload, dict) and payload.get("code") not in (0, "0", None):
        raise RuntimeError(f"JustOneAPI {payload.get('code')}: {payload.get('message') or payload}")
    return payload


def _normalize_note_detail(payload: dict) -> dict:
    data = payload.get("data") if isinstance(payload, dict) else payload
    note = _deep_get(data, ("note",), ("noteDetail",), ("note_detail",), ("items", 0), ("list", 0), default=data)
    if not isinstance(note, dict):
        note = data if isinstance(data, dict) else {}
    inter = _deep_get(note, ("interactInfo",), ("interact_info",), ("interaction",), ("statistics",), ("stats",), default={}) or {}
    user = _deep_get(note, ("user",), ("userInfo",), ("user_info",), ("author",), default={}) or {}
    title = _deep_get(note, ("title",), ("displayTitle",), ("display_title",), ("noteCard", "displayTitle"), default="")
    desc = _deep_get(note, ("desc",), ("description",), ("content",), default="")
    author = _deep_get(user, ("nickname",), ("nickName",), ("name",), ("userName",), default="")
    likes = _num(_deep_get(inter, ("likedCount",), ("liked_count",), ("likeCount",), ("like_count",), ("likes",), default=0)
                 or _deep_get(note, ("likedCount",), ("liked_count",), ("likeCount",), ("likes",), default=0))
    collects = _num(_deep_get(inter, ("collectedCount",), ("collected_count",), ("collectCount",), ("collect_count",), ("favCount",), ("favoriteCount",), default=0)
                    or _deep_get(note, ("collectedCount",), ("collectCount",), ("collects",), default=0))
    comments = _num(_deep_get(inter, ("commentCount",), ("comment_count",), ("comments",), default=0)
                    or _deep_get(note, ("commentCount",), ("comment_count",), default=0))
    shares = _num(_deep_get(inter, ("shareCount",), ("share_count",), ("shares",), default=0)
                  or _deep_get(note, ("shareCount",), ("share_count",), default=0))
    views = _num(_deep_get(inter, ("viewCount",), ("view_count",), ("readCount",), ("read_count",), ("exposure",), default=0)
                 or _deep_get(note, ("viewCount",), ("readCount",), ("views",), default=0))
    return {
        "title": title,
        "desc": desc,
        "author": author,
        "publishTime": _deep_get(note, ("time",), ("publishTime",), ("publish_time",), ("createTime",), ("create_time",), default=None),
        "metrics": {
            "views": views,
            "likes": likes,
            "collects": collects,
            "comments": comments,
            "shares": shares,
        },
        "rawNote": note,
    }


def _comment_texts(payload: dict, limit: int = 12):
    data = payload.get("data") if isinstance(payload, dict) else payload
    candidates = [
        _deep_get(data, ("comments",), default=None),
        _deep_get(data, ("commentList",), default=None),
        _deep_get(data, ("comment_list",), default=None),
        _deep_get(data, ("list",), default=None),
        _deep_get(data, ("items",), default=None),
    ]
    comments = next((x for x in candidates if isinstance(x, list)), [])
    out = []
    for c in comments[:limit]:
        if not isinstance(c, dict):
            continue
        text = _deep_get(c, ("content",), ("text",), ("comment",), ("desc",), default="")
        if text:
            out.append(str(text))
    return out


def _parse_opencli_scalar_yaml(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    key_re = re.compile(r"^\s*(?:-\s*)?([A-Za-z_][\w-]*)\s*:\s*(.*)\s*$")

    def clean(value: str) -> str:
        s = (value or "").strip()
        if s in {"", "[]", "{}", "null", "None", "|", "|-", ">", ">-"}:
            return ""
        if (len(s) >= 2 and s[0] == s[-1] and s[0] in {"'", '"'}):
            s = s[1:-1]
        return s.strip()

    current_field = ""
    value_lines: List[str] = []
    collecting_block = False

    def flush_field():
        nonlocal current_field, value_lines, collecting_block
        key = current_field.strip().lower().replace("-", "_")
        value = "\n".join(x for x in value_lines if x.strip()).strip()
        if key and value:
            out.setdefault(key, value)
        current_field = ""
        value_lines = []
        collecting_block = False

    for raw in (text or "").splitlines():
        line = raw.rstrip()
        field_match = re.match(r"^\s*-\s*field\s*:\s*(.+?)\s*$", line, re.I)
        if field_match:
            flush_field()
            current_field = clean(field_match.group(1))
            continue
        if current_field:
            value_match = re.match(r"^\s*value\s*:\s*(.*)\s*$", line, re.I)
            if value_match:
                value = value_match.group(1).strip()
                cleaned = clean(value)
                if cleaned:
                    value_lines.append(cleaned)
                    collecting_block = False
                else:
                    collecting_block = True
                continue
            if collecting_block or value_lines:
                if re.match(r"^\s{2,}\S", raw) or re.match(r"^\s*-\s+(?!field\s*:)", raw, re.I):
                    cleaned = clean(line)
                    if cleaned:
                        value_lines.append(cleaned)
                    continue
                flush_field()
        m = key_re.match(line)
        if not m:
            continue
        key = m.group(1).strip().lower().replace("-", "_")
        if key in {"field", "value"}:
            continue
        value = clean(m.group(2))
        if not value:
            continue
        out.setdefault(key, value)
    flush_field()
    return out


def _first_field(data: Dict[str, str], *names: str) -> str:
    for name in names:
        value = data.get(name.lower().replace("-", "_"))
        if value not in (None, ""):
            return str(value)
    return ""


def _normalize_opencli_xhs_note(text: str, url: str, note_id: str, fallback: str = "") -> dict:
    data = _parse_opencli_scalar_yaml(text)
    title = _first_field(data, "title", "note_title", "display_title", "displayTitle")
    desc = _first_field(data, "desc", "description", "summary", "content", "text", "note_desc")
    author = _first_field(data, "author", "nickname", "nick_name", "nickName", "user", "username")
    likes = _num(_first_field(data, "likes", "like", "liked_count", "likedCount", "like_count", "likeCount"))
    collects = _num(_first_field(data, "collects", "collected_count", "collectedCount", "collect_count", "collectCount", "favorites", "fav_count", "favoriteCount"))
    comments = _num(_first_field(data, "comments", "comment_count", "commentCount", "comment"))
    shares = _num(_first_field(data, "shares", "share_count", "shareCount", "share"))
    views = _num(_first_field(data, "views", "view_count", "viewCount", "read_count", "readCount", "reads", "exposure"))
    if not any([title, desc, likes, collects, comments, shares, views]):
        raise RuntimeError("OpenCLI 未返回可用笔记详情；小红书详情通常需要从搜索结果打开带 xsec_token 的完整链接")
    total_interactions = likes + collects + comments + shares
    engagement = total_interactions / views if views else 0
    score_base = views if views else total_interactions
    score = max(35, min(96, int((engagement * 520 if views else min(1, total_interactions / 5000) * 70) + len(str(score_base or 1)) * 8)))
    return {
        "provider": "agent-reach-opencli",
        "noteId": note_id,
        "title": title,
        "author": author,
        "publishTime": _first_field(data, "published_at", "publish_time", "publishTime", "create_time", "createTime") or None,
        "fetchedAt": int(time.time() * 1000),
        "metrics": {
            "views": views,
            "likes": likes,
            "collects": collects,
            "comments": comments,
            "shares": shares,
            "engagementRate": engagement,
            "qualityScore": score,
        },
        "commentsSample": [],
        "raw": {
            "provider": "agent-reach-opencli",
            "url": url,
            "fallback": fallback,
            "note": {k: v for k, v in data.items() if k not in {"token", "cookie", "authorization"}},
            "desc": desc,
            "viewsUnavailable": not bool(views),
        },
    }


async def _run_opencli_xhs_note(url: str) -> str:
    if os.getenv("AGENT_REACH_ANALYTICS", "auto").lower() in {"0", "false", "off", "no"}:
        raise RuntimeError("agent-reach 小红书采集已被环境变量关闭")
    if not shutil.which("opencli"):
        raise RuntimeError("agent-reach 当前小红书后端不可用：服务器进程未检测到 OpenCLI")
    try:
        run = await asyncio.to_thread(
            subprocess.run,
            ["opencli", "xiaohongshu", "note", url, "-f", "yaml"],
            cwd=str(FRONTEND_DIR),
            capture_output=True,
            text=True,
            timeout=45,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("agent-reach/OpenCLI 读取小红书笔记超时")
    raw = (run.stderr or run.stdout or "").strip()
    if run.returncode != 0:
        low = raw.lower()
        if any(x in low for x in ("auth", "login", "登录", "token", "cookie")):
            raise RuntimeError("agent-reach/OpenCLI 未获得服务器侧小红书登录态，请在服务器 OpenCLI 运行环境完成授权后重试")
        if "xsec" in low:
            raise RuntimeError("小红书详情需要带 xsec_token 的完整链接，请先从搜索结果打开原文链接后再采集")
        raise RuntimeError(f"agent-reach/OpenCLI 读取失败：{raw[:240] or '未知错误'}")
    return run.stdout


async def _opencli_xhs_search(query: str, limit: int = 6) -> List[Dict]:
    if not shutil.which("opencli"):
        raise RuntimeError("agent-reach 当前小红书后端不可用：服务器进程未检测到 OpenCLI")
    q = re.sub(r"\s+", " ", (query or "")).strip()[:90]
    if not q:
        return []
    try:
        run = await asyncio.to_thread(
            subprocess.run,
            ["opencli", "xiaohongshu", "search", q, "-f", "yaml"],
            cwd=str(FRONTEND_DIR),
            capture_output=True,
            text=True,
            timeout=35,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("agent-reach/OpenCLI 按标题重搜小红书超时")
    raw = (run.stderr or run.stdout or "").strip()
    if run.returncode != 0:
        low = raw.lower()
        if any(x in low for x in ("auth", "login", "登录", "token", "cookie")):
            raise RuntimeError("agent-reach/OpenCLI 未获得服务器侧小红书登录态，请在服务器 OpenCLI 运行环境完成授权后重试")
        raise RuntimeError(f"agent-reach/OpenCLI 按标题重搜失败：{raw[:220] or '未知错误'}")
    return _parse_xhs_opencli_yaml(run.stdout, limit)


def _normalize_opencli_xhs_search_item(item: Dict, note_id: str, title_hint: str, reason: str) -> dict:
    title = re.sub(r"\s+", " ", item.get("title") or title_hint or "").strip()
    desc = re.sub(r"\s+", " ", item.get("desc") or "").strip()
    author = re.sub(r"\s+", " ", item.get("author") or "").strip()
    likes = _num(item.get("likes"))
    if not any([title, desc, author, likes]):
        raise RuntimeError(reason)
    total_interactions = likes
    score = max(35, min(82, int(min(1, total_interactions / 3000) * 58 + len(str(total_interactions or 1)) * 7)))
    return {
        "provider": "agent-reach-opencli-search",
        "noteId": note_id,
        "title": title,
        "author": author,
        "publishTime": item.get("published_at") or None,
        "fetchedAt": int(time.time() * 1000),
        "metrics": {
            "views": 0,
            "likes": likes,
            "collects": 0,
            "comments": 0,
            "shares": 0,
            "engagementRate": 0,
            "qualityScore": score,
        },
        "commentsSample": [],
        "raw": {
            "provider": "agent-reach-opencli-search",
            "url": item.get("url") or "",
            "searchItem": item,
            "desc": desc,
            "viewsUnavailable": True,
            "detailUnavailable": True,
            "detailError": reason,
        },
    }


async def _opencli_xhs_note(url: str, note_id: str, title: str = "") -> dict:
    first_error = ""
    try:
        return _normalize_opencli_xhs_note(await _run_opencli_xhs_note(url), url, note_id)
    except Exception as exc:
        first_error = str(exc)
        if not (title or "").strip():
            raise

    items = await _opencli_xhs_search(title, 6)
    if not items:
        raise RuntimeError(f"{first_error}；已按标题重搜但没有找到可用候选")
    candidates = sorted(
        items,
        key=lambda item: 0 if (note_id and note_id in (item.get("url") or "")) else 1,
    )
    last_error = first_error
    for item in candidates:
        item_url = (item.get("url") or "").strip()
        if not item_url:
            continue
        try:
            return _normalize_opencli_xhs_note(
                await _run_opencli_xhs_note(item_url),
                item_url,
                note_id,
                fallback="title_search",
            )
        except Exception as exc:
            last_error = str(exc)
            continue
    return _normalize_opencli_xhs_search_item(candidates[0], note_id, title, last_error)


@app.post("/api/analytics/resolve")
async def analytics_resolve(req: AnalyticsResolveReq):
    """解析小红书分享链接。只做真实 URL 解析，不合成模拟数据。"""
    url = (req.url or "").strip()
    if not url:
        raise HTTPException(400, "链接为空，无法解析")
    return {
        "ok": True,
        "provider": "server-url-parser",
        "noteId": _note_id(url),
        "canonicalUrl": url,
        "resolvedAt": int(time.time() * 1000),
    }


@app.post("/api/analytics/fetch")
async def analytics_fetch(req: AnalyticsFetchReq):
    """拉取笔记指标。没有真实采集服务时明确失败，前端展示失败原因。"""
    note_id = req.noteId or _note_id(req.url)
    justone_error = ""
    if JUSTONEAPI_KEY:
        try:
            detail_raw = await _justone_get("/api/xiaohongshu/get-note-detail/v5", {"noteId": note_id})
            detail = _normalize_note_detail(detail_raw)
            comment_raw = await _justone_get("/api/xiaohongshu/get-note-comment/v4", {"noteId": note_id})
            comments_sample = _comment_texts(comment_raw)
            metrics = detail["metrics"]
            total_base = metrics["views"] or (metrics["likes"] + metrics["collects"] + metrics["comments"] + metrics["shares"]) * 20
            engagement = (metrics["likes"] + metrics["collects"] + metrics["comments"] + metrics["shares"]) / total_base if total_base else 0
            score = max(35, min(96, int(engagement * 520 + len(str(total_base or 1)) * 10)))
            return {
                "provider": "justoneapi",
                "noteId": note_id,
                "title": detail["title"],
                "author": detail["author"],
                "publishTime": detail["publishTime"],
                "fetchedAt": int(time.time() * 1000),
                "metrics": {
                    **metrics,
                    "views": metrics["views"],
                    "engagementRate": engagement,
                    "qualityScore": score,
                },
                "commentsSample": comments_sample,
                "raw": {
                    "detail": detail_raw,
                    "comments": comment_raw,
                    "note": detail["rawNote"],
                },
            }
        except Exception as exc:
            justone_error = f"JustOneAPI 调用失败：{str(exc)[:220]}"

    try:
        return await _opencli_xhs_note(req.url, note_id, req.title or "")
    except Exception as exc:
        prefix = f"{justone_error}；" if justone_error else ""
        raise HTTPException(503, f"{prefix}agent-reach/OpenCLI 未能返回小红书真实指标：{str(exc)[:260]}")



# =========================================================
# 共享后端（Phase 1）：登录鉴权 + 全量快照 + 文档写穿透 + 成员管理
# =========================================================
class LoginReq(BaseModel):
    username: str
    pin: str


class PutReq(BaseModel):
    items: list


class MemberReq(BaseModel):
    name: str = ""
    username: str = ""
    pin: str = ""
    role: str = "editor"


class MemberApplyReq(BaseModel):
    name: str = ""
    username: str = ""
    pin: str = ""
    role: str = "editor"
    message: str = ""


def _clean_role(role: str) -> str:
    return role if role in {"admin", "editor", "supplier"} else "editor"


def require_member(authorization: str = Header(default="")):
    mid = store.parse_token(authorization.replace("Bearer ", "").strip())
    row = store.get_member(mid) if mid else None
    if not row:
        raise HTTPException(401, "未登录或登录已过期")
    return store.member_public(row)


def require_admin(me=Depends(require_member)):
    if me["role"] != "admin":
        raise HTTPException(403, "需要管理员权限")
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
def api_state(response: Response, me=Depends(require_member)):
    """按当前成员可见性返回全量快照（owned 按 owner 过滤、jobs 跟随、其余共享）。"""
    response.headers["Cache-Control"] = "no-store"
    data = store.state_for(me["id"], me["role"])
    if me["role"] == "admin":
        data["members"] = store.list_members()
    return data


@app.put("/api/db/{collection}")
def api_put(collection: str, req: PutReq, me=Depends(require_member)):
    """写穿透：按 id upsert（后写胜），绝不整表删，故不会冲掉他人数据。"""
    try:
        store.upsert_docs(collection, req.items)
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("suspicious_account_bulk"):
            raise HTTPException(409, "检测到旧浏览器缓存正在批量回推账号，服务器已拒绝本次写入。请刷新页面后重新登录。")
        raise HTTPException(400, "未知集合")
    return {"ok": True, "n": len(req.items)}


@app.delete("/api/db/{collection}/{doc_id}")
def api_del(collection: str, doc_id: str, me=Depends(require_member)):
    try:
        store.delete_doc(collection, doc_id)
    except ValueError:
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
    data = await req.body()
    if not data:
        raise HTTPException(400, "文件为空")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    stem = _safe_file_stem(asset_id)
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
def file_get(name: str):
    path = _upload_path(name)
    if not path.exists():
        raise HTTPException(404, "文件不存在或已被清理")
    media = _media_type_for_path(path)
    return FileResponse(path, media_type=media, filename=path.name)


@app.delete("/api/files/{name}")
def file_delete(name: str, me=Depends(require_member)):
    path = _upload_path(name)
    if path.exists():
        path.unlink()
    return {"ok": True}


@app.get("/api/members")
def members_list(me=Depends(require_admin)):
    return store.list_members()


@app.post("/api/members")
def members_add(req: MemberReq, me=Depends(require_admin)):
    if not req.username.strip() or not req.pin:
        raise HTTPException(400, "用户名与初始密码必填")
    if store.get_member_by_username(req.username.strip()):
        raise HTTPException(409, "用户名已存在")
    return store.member_public(store.add_member(req.name or req.username, req.username.strip(), req.pin, _clean_role(req.role)))


@app.put("/api/members/{mid}")
def members_update(mid: str, req: MemberReq, me=Depends(require_admin)):
    username = req.username.strip() if req.username else None
    if username:
        existing = store.get_member_by_username(username)
        if existing and existing[0] != mid:
            raise HTTPException(409, "用户名已存在")
    row = store.update_member(mid, name=req.name or None, username=username, role=_clean_role(req.role) if req.role else None, pin=req.pin or None)
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
def member_requests_list(status: str = "", me=Depends(require_admin)):
    st = status if status in {"pending", "approved", "rejected"} else None
    return store.list_member_requests(st)


@app.post("/api/member-requests/{rid}/approve")
def member_requests_approve(rid: str, me=Depends(require_admin)):
    row, err = store.approve_member_request(rid, me["id"])
    if err == "not_found":
        raise HTTPException(404, "申请不存在")
    if err == "not_pending":
        raise HTTPException(409, "申请已处理")
    if err == "username_exists":
        raise HTTPException(409, "用户名已存在，无法通过")
    return {"ok": True, "member": store.member_public(row)}


@app.post("/api/member-requests/{rid}/reject")
def member_requests_reject(rid: str, me=Depends(require_admin)):
    ok, err = store.reject_member_request(rid, me["id"])
    if err == "not_found":
        raise HTTPException(404, "申请不存在")
    if err == "not_pending":
        raise HTTPException(409, "申请已处理")
    return {"ok": True}


# ---------- 前端静态资源（仅暴露必要文件，不整目录托管，避免泄露 _backup_*/源码/方案文档） ----------
app.mount("/js", NoCacheStaticFiles(directory=str(FRONTEND_DIR / "js")), name="js")
app.mount("/styles", NoCacheStaticFiles(directory=str(FRONTEND_DIR / "styles")), name="styles")
app.mount("/assets", NoCacheStaticFiles(directory=str(FRONTEND_DIR / "assets")), name="assets")


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
    return FileResponse(str(FRONTEND_DIR / "logo.png"))
