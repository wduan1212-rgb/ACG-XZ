from __future__ import annotations

import asyncio
import base64
import inspect
import json
import math
import re
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from .config import settings


ProgressCallback = Callable[[str, str, int], Awaitable[None]]

def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _safe_float(value: Any, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return result if math.isfinite(result) else default


_LOGO_ASSET_MARKERS = ("logo", "标志", "徽标", "角标", "水印", "icon")


def _is_logo_asset(asset: dict[str, Any]) -> bool:
    return str(asset.get("media_type") or "") == "image" and any(
        marker in str(asset.get("name") or "").lower()
        for marker in _LOGO_ASSET_MARKERS
    )


def _explicit_logo_overlay_labels(instruction: str, assets: list[dict[str, Any]]) -> set[str]:
    """Only corner/watermark wording turns an uploaded logo into an overlay."""
    text = re.sub(r"\s+", "", str(instruction or "")).lower()
    if not text:
        return set()
    corner_words = r"角标|水印|右上|左上|右下|左下|角落"
    generic = bool(re.search(r"(?:logo|标志|徽标|品牌).{0,18}(?:%s)|(?:%s).{0,18}(?:logo|标志|徽标|品牌)" % (corner_words, corner_words), text))
    selected: set[str] = set()
    for asset in assets:
        if not _is_logo_asset(asset):
            continue
        label = re.sub(r"\s+", "", str(asset.get("label") or ""))
        name = re.sub(r"\s+", "", str(asset.get("name") or "")).lower()
        clauses = [clause for clause in re.split(r"[，,。；;！!？?\n]+", text) if (label and label in clause) or (name and name in clause)]
        if generic or any(re.search(corner_words, clause) for clause in clauses):
            if label:
                selected.add(label)
    return selected


def _explicit_duration_seconds(messages: list[dict[str, Any]]) -> int | None:
    minute_patterns = (
        r"(?:总时长|成片时长|视频时长|时长)\s*(?:为|是|约|大约|控制在|做成)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:分钟|min\b)",
        r"(?:制作|创作|生成|做|剪|来)\s*(?:一条|一个|一段)?\s*(?:约|大约)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:分钟|min\b)",
        r"(?:一条|一个|一段)\s*(?:约|大约)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:分钟|min\b)",
    )
    patterns = (
        r"(?:总时长|成片时长|视频时长|时长)\s*(?:为|是|约|大约|控制在|做成)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)",
        r"(?:制作|创作|生成|做|剪|来)\s*(?:一条|一个|一段)?\s*(?:约|大约)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)",
        r"(?:一条|一个|一段)\s*(?:约|大约)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)",
        r"(?<![-–—\d])(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)\s*(?:左右|以内|以上)?\s*(?:的)?\s*(?:视频|成片|短片|片子)",
    )
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        text = str(message.get("content") or "")
        for pattern in minute_patterns:
            match = re.search(pattern, text, re.I)
            if not match:
                continue
            value = _safe_float(match.group(1), 0) * 60
            if 1 <= value <= 600:
                return max(1, int(round(value)))
        for pattern in patterns:
            match = re.search(pattern, text, re.I)
            if not match:
                continue
            value = _safe_float(match.group(1), 0)
            if 1 <= value <= 600:
                return max(1, int(round(value)))
    return None


def _explicit_input_mode(messages: list[dict[str, Any]]) -> str:
    """Classify user-owned script text without trusting model self-labeling."""
    latest = next(
        (str(item.get("content") or "") for item in reversed(messages) if item.get("role") == "user"),
        "",
    )
    if re.search(
        r"(?:以下|下面)(?:是|为)?(?:我的|这段)?(?:口播|旁白|脚本|文案)(?:原文)?|"
        r"(?:口播|旁白|脚本|文案)(?:原文)?\s*(?:如下|是|为|[:：])|"
        r"(?:照着|使用|保留).{0,12}(?:口播|旁白|脚本|文案).{0,8}(?:原文|不要改|不改写)|"
        r"(?:不要|无需|不需要).{0,8}(?:改写|重写).{0,8}(?:口播|旁白|脚本|文案)",
        latest,
        re.I,
    ):
        return "script"
    return "topic"


def _duration_character_floor(duration_sec: int | float | None) -> int:
    """Estimate a conservative narration floor without capping expression.

    Short-form narration often contains more pauses and emotional beats, while
    long explainers sustain a higher information density. A single multiplier
    therefore over-expands long videos. This curve is only a one-way floor;
    real MiniMax audio remains the authoritative timeline later in the
    pipeline and the director remains free to run naturally longer.
    """
    duration = max(0.0, float(duration_sec or 0))
    if duration <= 0:
        return 0
    if duration <= 60:
        chars_per_second = 6.0
    elif duration >= 180:
        chars_per_second = 5.2
    else:
        chars_per_second = 6.0 - ((duration - 60.0) / 120.0) * 0.8
    return max(12, int(round(duration * chars_per_second)))


def _partition_narration_excerpts(text: str, count: int) -> list[str]:
    """Create ordered, contiguous fallback spans without rewriting narration."""
    narration = str(text or "").strip()
    total = len(narration)
    count = max(1, int(count or 1))
    if not narration:
        return [""] * count
    if count == 1:
        return [narration]
    punctuation = set("。！？!?；;，,：:\n")
    boundaries = [0]
    for index in range(1, count):
        target = round(total * index / count)
        radius = max(8, min(80, total // max(2, count)))
        candidates = [
            pos + 1
            for pos in range(max(boundaries[-1] + 1, target - radius), min(total - 1, target + radius))
            if narration[pos] in punctuation
        ]
        boundary = min(candidates, key=lambda pos: abs(pos - target)) if candidates else target
        boundary = max(boundaries[-1] + 1, min(total - (count - index), boundary))
        boundaries.append(boundary)
    boundaries.append(total)
    return [narration[boundaries[i]:boundaries[i + 1]] for i in range(count)]


def _director_request_has_executable_brief(
    messages: list[dict[str, Any]],
    attachments: list[dict[str, Any]],
) -> bool:
    """Return whether the director already has enough information to create.

    This intentionally judges only whether production can start, not how the
    film should be made.  Audience, tone, ending, shot language and optional
    asset choices remain director decisions instead of becoming a form the
    user has to complete.
    """
    latest = next(
        (
            str(item.get("content") or "").strip()
            for item in reversed(messages)
            if item.get("role") == "user"
        ),
        "",
    )
    meaningful = re.sub(r"[\s\W_]+", "", latest, flags=re.UNICODE)
    if attachments and len(meaningful) >= 4:
        return True
    if len(meaningful) < 10:
        return False
    # A reasonably specific title, script, topic or objective is executable.
    # Do not require a fixed vocabulary: creative requests are often just a
    # natural-language title followed by one desired outcome.
    return bool(
        _explicit_duration_seconds(messages)
        or re.search(
            r"视频|短片|成片|口播|主题|测评|介绍|展示|讲|做|生成|创作|改成|重做",
            latest,
            re.I,
        )
        or len(meaningful) >= 18
    )


def _explicit_audience_enumerations(text: str) -> list[str]:
    """Extract only unmistakable three-part audience lists from narration."""
    found: list[str] = []
    pattern = re.compile(
        r"(?:假如你是|如果你是|适合|面向)?"
        r"([一-鿿]{2,8}(?:人|党|族|者))、"
        r"([一-鿿]{2,8}(?:人|党|族|者))"
        r"[、和及与]"
        r"([一-鿿]{2,8}(?:人|党|族|者))"
    )
    for match in pattern.finditer(str(text or "")):
        for value in match.groups():
            if value not in found:
                found.append(value)
    return found


_READABLE_TEXT_CUE = re.compile(
    r"(?:字幕|花字|标题|副标题|大字|小字|字样|文案|文字|写着|显示(?:出|为)?|"
    r"可读|清晰读出|UI展示清晰|评论区气泡|榜单文字|标签云)",
    re.I,
)

_CAPTION_RENDER_CUE = re.compile(
    r"(?:字幕|花字|口播原文|逐字稿|跟随口播|同步口播|大段文案|滚动文字)",
    re.I,
)

_SEEDANCE_TEXT_NEGATIVE = "无字幕、无花字、无水印、无二维码；除导演明确指定的短界面标签外，不生成其他文字。"


def _visual_prompt_tokens(text: str) -> set[str]:
    """Return content-bearing CJK bigrams for visual-plan similarity checks."""
    normalized = re.sub(
        r"(?:9:16|16:9|1:1|3:4|4:3|21:9|竖屏|横屏|构图|画面|镜头|整体|"
        r"主色调|电影感|景深|光线|色调|出现|切换|随后|最后|轻微|逐渐|依次)",
        "",
        str(text or ""),
        flags=re.I,
    )
    normalized = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9]+", "", normalized).lower()
    if len(normalized) < 2:
        return {normalized} if normalized else set()
    return {normalized[index:index + 2] for index in range(len(normalized) - 1)}


def _visual_prompt_similarity(left: str, right: str) -> float:
    left_tokens = _visual_prompt_tokens(left)
    right_tokens = _visual_prompt_tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _render_action_signature(prompt: str) -> str:
    """Return only the unique actions of one technical submission."""
    actions = [
        line.lstrip()[2:].strip()
        for line in str(prompt or "").splitlines()
        if line.lstrip().startswith("- ") and line.lstrip()[2:].strip()
    ]
    return "\n".join(actions) or str(prompt or "")


def _visual_template_signature(text: str) -> set[str]:
    """Identify repeated visual grammar even when nouns have been swapped."""
    source = str(text or "")
    patterns = {
        "card-grid": r"(?:卡片|色块).{0,45}(?:并排|网格|排列|依次)",
        "card-highlight": r"(?:卡片|色块).{0,55}(?:高亮|放大|亮起|淡化)",
        "readable-ui": r"(?:UI|界面|菜单|输入框|榜单|标签云|清单|时间轴)",
        "desk-computer": r"(?:办公室|工作台|桌前).{0,55}(?:电脑|屏幕|键盘)",
        "center-logo": r"(?:Logo|标志).{0,30}(?:居中|中央|发光)",
        "split-compare": r"(?:左右分屏|前后对比|对比画面)",
        "floating-copy": r"(?:出现|浮现).{0,50}(?:标题|大字|小字|字样|文案)",
    }
    return {name for name, pattern in patterns.items() if re.search(pattern, source, re.I)}


def _sanitize_seedance_visual_text(text: str) -> str:
    """Remove narration/caption requests from provider-facing prompts.

    Semantic narration anchors stay in the director plan.  Seedance only sees
    the visual execution plan. Short intentional UI labels stay available so
    buttons and product screens can remain legible; spoken copy and caption
    layer instructions are not passed to the video model.
    """
    source = str(text or "").strip()
    if not source:
        return ""
    # Resumed jobs may cross this boundary more than once.  Remove the
    # render-only negative here and let _seedance_prompt append one canonical
    # copy after the visual prompt has been cleaned.
    source = source.replace(_SEEDANCE_TEXT_NEGATIVE, "")
    source = re.sub(r"本段对应口播原文\s*[：:]\s*[^\n]+", "", source)
    source = re.sub(r"(?:说到|口播提到)[“\"'][^”\"']+[”\"']时\s*[：:]?", "", source)
    kept: list[str] = []
    for raw_line in source.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        fragments = re.split(r"(?<=[。！？!?；;])", line)
        cleaned_fragments: list[str] = []
        for fragment in fragments:
            if _CAPTION_RENDER_CUE.search(fragment):
                # Preserve useful physical action, but remove requests for a
                # subtitle/caption layer. Short interface copy remains valid.
                fragment = re.sub(
                    r"(?:上|下|旁边|中央|画面中|卡片上)?(?:出现|浮现|写着|显示)?[^。！？!?；;]{0,90}"
                    r"(?:字幕|花字|口播原文|逐字稿|跟随口播|同步口播|大段文案|滚动文字)"
                    r"[^。！？!?；;]*",
                    "",
                    fragment,
                    flags=re.I,
                ).strip()
            if fragment:
                cleaned_fragments.append(fragment)
        cleaned = "".join(cleaned_fragments).strip()
        if cleaned:
            kept.append(cleaned)
    cleaned_source = "\n".join(kept)
    cleaned_source = re.sub(r"\s{2,}", " ", cleaned_source)
    return cleaned_source.strip(" \t\r\n。；;")


def _tts_speed_for_target(text: str, target_duration_sec: float | None) -> float:
    # Keep the platform voice model at its natural cadence.  The measured audio
    # duration, not a requested duration or a fixed multiplier, drives editing.
    return 1.0


def _client(
    timeout: float | httpx.Timeout,
    follow_redirects: bool = False,
) -> httpx.AsyncClient:
    timeout_config = (
        timeout
        if isinstance(timeout, httpx.Timeout)
        else httpx.Timeout(timeout, connect=15.0)
    )
    kwargs: dict[str, Any] = {
        "timeout": timeout_config,
        "trust_env": False,
    }
    client_parameters = inspect.signature(httpx.AsyncClient).parameters
    if "follow_redirects" in client_parameters:
        kwargs["follow_redirects"] = follow_redirects
    if settings.outbound_proxy:
        proxy_keyword = (
            "proxy" if "proxy" in client_parameters else "proxies"
        )
        kwargs[proxy_keyword] = settings.outbound_proxy
    return httpx.AsyncClient(**kwargs)


def _stream(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    follow_redirects: bool = False,
    **kwargs: Any,
) -> Any:
    if follow_redirects:
        stream_parameters = inspect.signature(client.stream).parameters
        redirect_keyword = (
            "follow_redirects"
            if "follow_redirects" in stream_parameters
            else "allow_redirects"
        )
        kwargs[redirect_keyword] = True
    return client.stream(method, url, **kwargs)


def _json_error(response: httpx.Response) -> str:
    try:
        data = response.json()
    except Exception:
        return response.text[:800]
    for key in ("message", "detail", "error", "base_resp"):
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(value, str) and value:
            return value[:800]
        if isinstance(value, dict):
            for nested in ("message", "status_msg", "detail", "code"):
                if value.get(nested):
                    return str(value[nested])[:800]
    return json.dumps(data, ensure_ascii=False)[:800]


class ProviderError(RuntimeError):
    pass


class _RetryableDownloadError(RuntimeError):
    pass


LLM_TRANSIENT_STATUS = {408, 425, 429, 500, 502, 503, 504}


def _llm_permanent_limit(detail: str) -> bool:
    value = str(detail or "").lower()
    return any(marker in value for marker in (
        "余额", "额度", "insufficient", "quota", "credit",
    ))


def _llm_message_usable(data: Any) -> bool:
    try:
        message = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return False
    if not isinstance(message, dict):
        return False
    calls = message.get("tool_calls") or []
    if not calls and message.get("function_call"):
        calls = [{"function": message["function_call"]}]
    if calls:
        if not isinstance(calls, list) or not isinstance(calls[0], dict):
            return False
        function = calls[0].get("function") or {}
        if not isinstance(function, dict):
            return False
        try:
            _decode_tool_arguments(function.get("arguments"))
        except ProviderError:
            return False
        return bool(function.get("name"))
    return bool(str(message.get("content") or "").strip())


def _decode_tool_arguments(value: Any) -> dict[str, Any]:
    """Decode one tool argument object without greedy brace recovery.

    Function-call arguments are required to be a JSON object.  Treating a
    malformed string as a partial object can silently route the wrong local
    edit, so malformed or non-object values are retried and then surfaced.
    """
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        raise ProviderError("MiniMax-M3 返回了无法解析的工具参数")
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ProviderError("MiniMax-M3 返回了无法解析的工具参数") from exc
    if not isinstance(decoded, dict):
        raise ProviderError("MiniMax-M3 工具参数必须是对象")
    return decoded


async def _post_llm_json_with_retry(
    payload: dict[str, Any],
    *,
    timeout: float = 150,
    label: str = "MiniMax-M3",
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    last_detail = ""
    max_attempts = 3
    retry_delays = (0.35, 0.9)
    for attempt in range(max_attempts):
        try:
            async with _client(timeout) as client:
                response = await client.post(
                    settings.llm_endpoint,
                    json=payload,
                    headers=headers,
                )
        except httpx.RequestError as exc:
            last_detail = exc.__class__.__name__
            if attempt < max_attempts - 1:
                await asyncio.sleep(retry_delays[attempt])
                continue
            raise ProviderError(f"{label}请求失败：{last_detail}") from exc
        detail = _json_error(response).strip()
        if response.status_code >= 400:
            last_detail = detail or f"HTTP {response.status_code}"
            if (
                attempt < max_attempts - 1
                and response.status_code in LLM_TRANSIENT_STATUS
                and not _llm_permanent_limit(last_detail)
            ):
                await asyncio.sleep(retry_delays[attempt])
                continue
            raise ProviderError(f"{label}请求失败：{last_detail}")
        try:
            data = response.json()
        except (TypeError, ValueError) as exc:
            last_detail = "返回内容不是合法 JSON"
            if attempt < max_attempts - 1:
                await asyncio.sleep(retry_delays[attempt])
                continue
            raise ProviderError(f"{label}请求失败：{last_detail}") from exc
        base_resp = data.get("base_resp") if isinstance(data, dict) else None
        if isinstance(base_resp, dict) and int(base_resp.get("status_code") or 0) != 0:
            last_detail = str(base_resp.get("status_msg") or "模型返回错误")
            transient = bool(re.search(r"繁忙|稍后|限流|频率|timeout|timed out|rate limit|too many", last_detail, re.I))
            if attempt < max_attempts - 1 and transient and not _llm_permanent_limit(last_detail):
                await asyncio.sleep(retry_delays[attempt])
                continue
            raise ProviderError(f"{label}请求失败：{last_detail}")
        if _llm_message_usable(data):
            return data
        last_detail = "没有返回可用消息或工具参数"
        if attempt < max_attempts - 1:
            await asyncio.sleep(retry_delays[attempt])
            continue
        raise ProviderError(f"{label}请求失败：{last_detail}")
    raise ProviderError(f"{label}请求失败：{last_detail or '未知错误'}")


SEEDANCE_DOWNLOAD_ATTEMPTS = 4
SEEDANCE_DOWNLOAD_TIMEOUT = httpx.Timeout(
    connect=30.0,
    read=300.0,
    write=60.0,
    pool=30.0,
)


async def _download_retry_sleep(delay: float) -> None:
    await asyncio.sleep(delay)


def _transient_download_status(status_code: int) -> bool:
    return status_code in {408, 425, 429} or 500 <= status_code < 600


async def _download_seedance_video(
    video_url: str,
    output_path: Path,
    *,
    callback: ProgressCallback | None,
    scene_number: int,
    max_attempts: int = SEEDANCE_DOWNLOAD_ATTEMPTS,
) -> None:
    """Download an already-generated Seedance clip without resubmitting it."""

    attempts = max(1, int(max_attempts or 1))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = output_path.with_name(
        f".{output_path.name}.{uuid.uuid4().hex}.part"
    )
    last_failure = ""
    try:
        for attempt in range(1, attempts + 1):
            try:
                temp_path.unlink(missing_ok=True)
                async with _client(SEEDANCE_DOWNLOAD_TIMEOUT) as client:
                    async with _stream(
                        client,
                        "GET",
                        video_url,
                        follow_redirects=True,
                        headers={"Accept": "video/*,application/octet-stream"},
                    ) as response:
                        if response.status_code >= 400:
                            await response.aread()
                            detail = _json_error(response).strip()
                            label = f"HTTP {response.status_code}"
                            if detail:
                                label += f" · {detail}"
                            if _transient_download_status(response.status_code):
                                raise _RetryableDownloadError(label)
                            raise ProviderError(
                                f"Seedance 第 {scene_number} 段下载失败：{label}"
                            )

                        expected_size = 0
                        try:
                            expected_size = max(
                                0,
                                int(response.headers.get("content-length") or 0),
                            )
                        except (TypeError, ValueError):
                            expected_size = 0
                        written = 0
                        with temp_path.open("wb") as handle:
                            async for chunk in response.aiter_bytes(
                                chunk_size=1024 * 1024
                            ):
                                if not chunk:
                                    continue
                                handle.write(chunk)
                                written += len(chunk)
                            handle.flush()
                        if written <= 0:
                            raise _RetryableDownloadError("下载结果为空")
                        if expected_size and written != expected_size:
                            raise _RetryableDownloadError(
                                f"下载不完整（{written}/{expected_size} 字节）"
                            )

                temp_path.replace(output_path)
                return
            except ProviderError:
                temp_path.unlink(missing_ok=True)
                raise
            except (httpx.RequestError, _RetryableDownloadError) as exc:
                temp_path.unlink(missing_ok=True)
                last_failure = (
                    exc.__class__.__name__
                    if isinstance(exc, httpx.RequestError)
                    else str(exc)
                )
                if attempt >= attempts:
                    raise ProviderError(
                        f"Seedance 第 {scene_number} 段成片下载失败："
                        f"已重试 {attempts} 次，最后错误为 {last_failure}"
                    ) from exc
                if callback:
                    await callback(
                        f"镜头 {scene_number} 成片下载短暂中断，正在重试",
                        "Seedance 生成任务已完成；当前只重新下载成片，"
                        f"第 {attempt + 1} 次下载不会重新提交生成。",
                        min(60, 54 + attempt),
                    )
                await _download_retry_sleep(min(12.0, float(2 ** attempt)))
            except OSError as exc:
                temp_path.unlink(missing_ok=True)
                raise ProviderError(
                    f"Seedance 第 {scene_number} 段成片写入失败："
                    f"{exc.__class__.__name__}"
                ) from exc
    finally:
        temp_path.unlink(missing_ok=True)


class MiniMaxDirector:
    def __init__(self) -> None:
        self.tools = [
            {
                "type": "function",
                "function": {
                    "name": "ask_user",
                    "description": "只有缺少主题、主体或核心目标，导致根本无法开始制作时，才追问一个阻断性问题。不得追问风格、受众细分、镜头、结尾或可选素材偏好。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string"},
                            "missing": {"type": "array", "items": {"type": "string"}},
                            "suggestions": {
                                "type": "array",
                                "minItems": 2,
                                "maxItems": 3,
                                "items": {"type": "string"},
                            },
                        },
                        "required": ["question", "missing", "suggestions"],
                    },
                },
            },
            {
                "type": "function",
                "function": {
                    "name": "start_video_production",
                    "description": "形成符合用户定制需求的完整视频导演计划并开始制作。",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "input_mode": {
                                "type": "string",
                                "enum": ["topic", "script", "audio"],
                                "description": "本次创作的主输入：选题、口播文本或口播音频。",
                            },
                            "aspect_ratio": {
                                "type": "string",
                                "enum": ["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"],
                            },
                            "duration_sec": {
                                "type": "integer",
                                "minimum": 1,
                                "description": "导演根据口播与叙事需要估算的成片总时长；用户未指定时由导演自主决定。",
                            },
                            "audience": {"type": "string"},
                            "tone": {"type": "string"},
                            "core_message": {"type": "string"},
                            "narration": {
                                "type": "string",
                                "description": "完整口播。篇幅、结构和语言由用户目标与导演判断决定。",
                            },
                            "scenes": {
                                "type": "array",
                                "minItems": 1,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "title": {"type": "string"},
                                        "duration_sec": {
                                            "type": "integer",
                                            "minimum": 4,
                                            "maximum": 15,
                                            "description": "Seedance 单个生成片段的技术时长，必须为 4 到 15 秒。",
                                        },
                                        "visual_prompt": {
                                            "type": "string",
                                            "description": "可直接交给 Seedance 的中文镜头提示词，包含主体、景别、动作、镜头运动、光线和连续性。",
                                        },
                                        "narration_excerpt": {
                                            "type": "string",
                                            "description": "这个镜头承接的连续口播原文；按口播先后顺序摘取，不改写、不跳段。",
                                        },
                                        "visual_beats": {
                                            "type": "array",
                                            "maxItems": 8,
                                            "description": "本技术片段内由口播语义自然产生的内部剪辑节拍；没有必要时可为空，不按固定数量或等间隔凑数。",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "narration_anchor": {
                                                        "type": "string",
                                                        "description": "从 narration_excerpt 原样摘取的短语。",
                                                    },
                                                    "visual_action": {
                                                        "type": "string",
                                                        "description": "该短语对应的具体人物、物件、动作、界面变化或视觉隐喻。",
                                                    },
                                                    "camera": {
                                                        "type": "string",
                                                        "description": "必要时描述景别、机位或镜头运动。",
                                                    },
                                                    "transition": {
                                                        "type": "string",
                                                        "description": "与前后节拍的自然连接方式。",
                                                    },
                                                    "shot_intent": {
                                                        "type": "string",
                                                        "description": "这次切换要新增的信息、情绪或叙事作用；没有新增价值时不要切。",
                                                    },
                                                    "pace": {
                                                        "type": "string",
                                                        "enum": ["flash", "quick", "hold", "release"],
                                                        "description": "按当前口播语义决定的相对节奏：闪现、快速推进、停留理解或释放收束，不代表固定秒数。",
                                                    },
                                                    "transition_reason": {
                                                        "type": "string",
                                                        "description": "为什么在这个口播锚点改变画面，而不是机械按时间切换。",
                                                    },
                                                },
                                                "required": ["narration_anchor", "visual_action"],
                                            },
                                        },
                                        "narrative_role": {
                                            "type": "string",
                                            "description": "这一段在整片中的叙事职责，例如建立、揭示、举证、对比、转折或收束。",
                                        },
                                        "shot_intent": {
                                            "type": "string",
                                            "description": "该片段整体希望观众看到、感到或理解的变化。",
                                        },
                                        "purpose": {"type": "string"},
                                    },
                                    "required": [
                                        "title",
                                        "duration_sec",
                                        "visual_prompt",
                                        "narration_excerpt",
                                        "visual_beats",
                                        "narrative_role",
                                        "shot_intent",
                                        "purpose",
                                    ],
                                },
                            },
                            "director_note": {
                                "type": "string",
                                "description": "面向用户的简短导演说明，只说明取舍，不输出隐藏推理。",
                            },
                            "audio_design": {
                                "type": "object",
                                "description": "声音导演方案。BGM 可关闭，存在用户口播音频时不得重新配音。",
                                "properties": {
                                    "bgm_enabled": {"type": "boolean"},
                                    "bgm_mood": {"type": "string"},
                                    "bgm_track_id": {
                                        "type": "string",
                                        "description": "可从可用 BGM 清单选择；不指定时留空，由系统稳定选择。",
                                    },
                                    "bgm_volume": {
                                        "type": "number",
                                        "minimum": 0.03,
                                        "maximum": 0.3,
                                    },
                                    "sound_note": {"type": "string"},
                                },
                                "required": [
                                    "bgm_enabled",
                                    "bgm_mood",
                                    "bgm_track_id",
                                    "bgm_volume",
                                    "sound_note",
                                ],
                            },
                            "public_thoughts": {
                                "type": "array",
                                "description": "可公开展示给用户的导演决策摘要，不是隐藏思维链。",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "title": {"type": "string"},
                                        "detail": {"type": "string"},
                                    },
                                    "required": ["title", "detail"],
                                },
                            },
                            "asset_assignments": {
                                "type": "array",
                                "maxItems": 8,
                                "description": "逐个附件说明生成参考或后期剪辑用途；没有附件时返回空数组。",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "asset_id": {"type": "string"},
                                        "label": {"type": "string", "description": "必须使用附件清单中的图N或视频N。"},
                                        "role": {
                                            "type": "string",
                                            "enum": [
                                                "reference",
                                                "material",
                                                "both",
                                                "narration",
                                                "bgm",
                                                "sfx",
                                                "unused",
                                            ],
                                        },
                                        "presentation": {
                                            "type": "string",
                                            "enum": ["auto", "overlay", "pip", "cutaway"],
                                            "description": "素材呈现方式。Logo、透明标志和角标使用 overlay；素材视频可使用 pip；只有需要替换主画面时才使用 cutaway。",
                                        },
                                        "position": {
                                            "type": "string",
                                            "enum": ["top-left", "top-right", "bottom-left", "bottom-right", "center"],
                                        },
                                        "scale": {
                                            "type": "number",
                                            "minimum": 0.1,
                                            "maximum": 0.65,
                                            "description": "叠加素材占画面宽度的比例。",
                                        },
                                        "scene_number": {"type": "integer", "minimum": 1},
                                        "narration_anchor": {
                                            "type": "string",
                                            "description": "从口播中原样摘取一段短语，素材在说到这里时出现。",
                                        },
                                        "duration_sec": {"type": "number", "minimum": 0.5},
                                        "source_start_sec": {"type": "number", "minimum": 0},
                                        "volume": {
                                            "type": "number",
                                            "minimum": 0,
                                            "maximum": 1.5,
                                            "description": "仅音频素材使用；口播主音轨固定按主声道处理。",
                                        },
                                        "reason": {"type": "string"},
                                    },
                                    "required": [
                                        "asset_id",
                                        "label",
                                        "role",
                                        "presentation",
                                        "position",
                                        "scale",
                                        "scene_number",
                                        "narration_anchor",
                                        "duration_sec",
                                        "source_start_sec",
                                        "volume",
                                        "reason",
                                    ],
                                },
                            },
                        },
                        "required": [
                            "title",
                            "input_mode",
                            "aspect_ratio",
                            "duration_sec",
                            "audience",
                            "tone",
                            "core_message",
                            "narration",
                            "scenes",
                            "director_note",
                            "audio_design",
                            "public_thoughts",
                            "asset_assignments",
                        ],
                    },
                },
            },
        ]

    def _system_prompt(
        self,
        aspect_ratio: str,
        skill_context: str,
        bgm_catalog: list[dict[str, str]],
        requested_duration_sec: int | None = None,
    ) -> str:
        bgm_options = json.dumps(bgm_catalog, ensure_ascii=False)
        if requested_duration_sec:
            # Deliveries default to 1.2x. Treat the stated duration as a floor,
            # not a narrow target that tempts the director to delete content.
            # Real TTS duration remains the authoritative edit clock later.
            minimum_chars = _duration_character_floor(requested_duration_sec)
            duration_instruction = (
                f"用户希望最终成片不少于 {requested_duration_sec} 秒，发布版默认会做 1.2x 变速。"
                f"请保持表达完整，正常语速原始口播至少预留约 {minimum_chars} 个有效字符的信息量；"
                "不设狭窄上限，内容需要时最终成片多 15–30 秒是允许的，但不得比用户指定时长更短。"
                "这只是总时长下限，不规定镜头数、切镜间隔或叙事公式。"
            )
        else:
            duration_instruction = "用户没有明确指定总时长，口播篇幅由你根据表达完整度自主决定。"
        return f"""你是星阵视频工坊的总导演 Agent。这个工作台只服务定制化、高质量视频，你拥有叙事、口播、总时长、镜头数量、镜头节奏、视觉方案和声音设计的完整导演权。

本次时长执行：{duration_instruction}

工作方式：
1. 你必须调用 ask_user 或 start_video_production，不能只写普通文本。
2. 用户要求拥有最高优先级。系统根据当前会话识别画幅为 {aspect_ratio}；用户没有说明画幅时才默认 9:16。
3. ask_user 只能用于缺少“要做什么”这类真正无法开工的核心信息。只要用户已经给出了可执行的主题、标题、口播、对象或目标之一，就应立即自主制作。受众细分、视觉调性、结尾方式、镜头语言、可选附件、是否有官方素材等都是导演应自主决策的创作项，不得因此追问。一次只能追问一个真正阻断生产的问题。
4. 用户明确指定时长、结构、风格或镜头数量时必须执行；用户未指定时，由你根据表达完整度自主决定，不得套用固定时长、固定段数、固定文案字数或固定叙事公式。
5. 先理解完整口播，再按语义变化规划画面。每个 scene 的 narration_excerpt 必须按先后顺序承接一段连续口播原文；相邻 scene 不重叠、不倒序，合起来尽量覆盖全部有效口播。不要只按标点机械切句，也不要让画面脱离它对应的口播。
6. duration_sec 是你对完整口播时长的估算。scenes 数量由你决定；每个 Seedance 原始片段受接口限制只能为 4 到 15 秒，这只是技术生成单元，不等于成片里只能有一个镜头。一个技术片段可以通过清晰的时间结构包含多次内部镜头变化；不要把接口时长误当成固定切镜时长，也不要套用固定镜头数量或固定拆句公式。
7. 先做叙事镜头计划，再做内部剪辑决定。为每个 scene 明确 narrative_role 和 shot_intent；再从 narration_excerpt 识别人物、对象、数字、列举项、对比、因果、过程和情绪转折，把抽象表达变成可看见的主体与动作。比如口播列举三类人群，应让三类人群在对应语义出现时各自被看见，而不是只给一张泛化办公画面；流程、对比和结果变化也要逐步发生。优先用真实人物、物件、动作、空间关系、结果变化和有意义的视觉隐喻发散，不要连续使用同一种卡片高亮、UI 列表或模板化信息图代替导演创作。
8. visual_beats 是片段内部的剪辑决策，不按固定数量、固定秒数或等间隔凑数。每个节拍都要说明 shot_intent、相对 pace 和 transition_reason：列举、反差、动作连锁、笑点或强调可快速推进；情绪建立、关键证据、复杂界面和需要看清的结果应主动停留；转折后可以释放收束。相邻节拍应有快慢变化，每一次切换都必须新增信息、情绪或视角；没有新增价值时宁可保持长镜头。
9. 每个 visual_prompt 都必须是可独立执行的纯视觉技术片段描述，因为不同 scene 会作为独立任务提交。它只写观众会看到的主体、环境、动作、景别、机位、光线、空间变化和连续性；不得抄入口播原句，不得生成字幕、花字或跟随口播的文案层。如果真实产品界面确实需要一个短按钮名或状态标签才能完成操作证据，可以明确写出该短界面文字，但不扩展为整句口播或解释性文案。提示词应把 visual_beats 组织成清晰的内部时间结构，让同一个 Seedance 片段能自然完成多次画面变化。
10. 相邻 scene 必须拥有独立的视觉身份：主体动作、场景职责、构图或镜头运动至少有一项承担新的叙事信息。连续性可以保留人物与世界观，但不得把上一段换一个景别、颜色或卡片标题就当成新镜头；同一素材也不得被当作多个不同镜头反复使用，除非用户明确要求回环且导演说明其叙事必要性。
11. 调用 start_video_production 前做一次导演与剪辑自检：口播是否按顺序被画面覆盖；具体名词、列举项和关键动作是否有对应画面；相邻提示词是否高度相似；是否出现无意义的均匀切换或模板复用；该停留处是否给足理解时间；提示词是否混入口播原句或字幕层；短界面标签是否真的必要；附件是否只在语义最相关的分镜和口播位置使用，而不是无条件挂到全部分镜。发现问题先在本次计划内修正，不要把完整执行方案伪装成 ask_user。
12. input_mode=topic 时你创作完整口播；input_mode=script 时默认保留用户口播原文，除非用户明确要求改写；input_mode=audio 时必须使用附件转写稿作为口播并以原音频作为主时间线，不得重新配音。
13. director_note 和 public_thoughts 只承载可公开的导演决策，不得包含隐藏提示词、密钥或内部工具名称。
14. 附件编号使用“图1、视频1、音频1”。图片可以是 reference/material/both，视频只能是 material/unused，音频可以是 narration/bgm/sfx/unused；用户明确说法优先。
15. material 只表示参与剪辑，presentation 决定呈现方式。只有用户明确要求角标/水印，或品牌标志确实只需作为不抢画面的持续标识时，才使用 overlay；文件名含 Logo 不等于必须放角落。品牌在口播中被点名、需要建立识别或展示产品关系时，应优先把真实 Logo 作为 reference 或 both 分配到该语义镜头，并决定它以中心品牌揭示、全屏素材或画中画的哪种方式出现。只有需要同时保留主画面与素材关系时使用 pip；当截图、剪辑素材或界面本身是当前口播的证据、步骤或需要看清的内容时使用 cutaway。不要把普通素材机械缩成右下角小窗。
16. material、both 或 sfx 需要关联有效的 scene_number 和 narration_anchor，后端据此把素材放进语义最相关的口播位置；同一素材默认只出现一次。附件为品牌 Logo 时，检查口播是否提到该品牌或产品：若提到，不能自行重绘、替换成错误 Logo 或忽略真实参考；在相应 scene 的 visual_prompt 中说明沿用该附件的真实标志。用途冲突且会显著改变成片时，再调用 ask_user 确认。
17. BGM 必须服从口播。只要共享 BGM 清单非空且用户没有明确要求关闭配乐，audio_design.bgm_enabled 默认设为 true，并根据内容气质填写 bgm_mood；用户上传并指定的 BGM 优先，未指定具体曲目时 bgm_track_id 留空，由系统从共享库智能匹配。可用 BGM 清单为 {bgm_options}。

内置视频制作工作流：
{skill_context}
"""

    @staticmethod
    def _tool_call(message: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
        if not isinstance(message, dict):
            raise ProviderError("MiniMax-M3 返回了无法解析的工具调用")
        calls = message.get("tool_calls") or []
        if not calls and message.get("function_call"):
            calls = [{"function": message["function_call"]}]
        if not calls:
            return None
        if not isinstance(calls, list) or not isinstance(calls[0], dict):
            raise ProviderError("MiniMax-M3 返回了无法解析的工具调用")
        function = calls[0].get("function") or {}
        if not isinstance(function, dict):
            raise ProviderError("MiniMax-M3 返回了无法解析的工具调用")
        name = str(function.get("name") or "")
        arguments = _decode_tool_arguments(function.get("arguments"))
        return name, arguments

    async def revise_narration_duration(
        self,
        plan: dict[str, Any],
        measured_duration: float,
        requested_duration: float,
        delivery_speed: float = 1.2,
    ) -> str:
        """Revise topic narration from measured audio, without touching shots.

        Character counts only guide the first draft. This second pass receives
        the actual MiniMax audio duration and changes narration only when the
        measured delivery falls outside the user's broad duration window.
        """
        if not settings.llm_api_key:
            raise ProviderError("导演语言模型未配置，无法根据真实口播时长复核")
        current = str(plan.get("narration") or "").strip()
        if not current:
            raise ProviderError("时长复核缺少口播文本")
        delivered = float(measured_duration or 0) / max(0.1, float(delivery_speed or 1.2))
        lower = float(requested_duration)
        upper = lower + 30.0
        direction = "自然扩充有用信息" if delivered < lower else "精简重复或次要表达"
        effective_chars = len(re.sub(
            r"[\s，。！？!?；;：:,、（）()《》“”‘’\-—…]",
            "",
            current,
        ))
        measured = max(0.1, float(measured_duration or 0.1))
        lower_chars = max(1, round(effective_chars * lower * delivery_speed / measured))
        upper_chars = max(lower_chars, round(effective_chars * upper * delivery_speed / measured))
        target_chars = round((lower_chars + upper_chars) / 2)
        character_boundary = (
            f"复核稿不得少于 {lower_chars} 个有效字符"
            if delivered < lower
            else f"复核稿不得超过 {upper_chars} 个有效字符"
        )
        tool = {
            "type": "function",
            "function": {
                "name": "revise_narration_duration",
                "description": "只返回复核后的完整口播文本。",
                "parameters": {
                    "type": "object",
                    "properties": {"narration": {"type": "string"}},
                    "required": ["narration"],
                },
            },
        }
        payload = {
            "model": settings.llm_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是视频工坊的口播剪辑。只根据真实音频时长复核口播，"
                        "不规定镜头数、切镜节奏、画面公式或附件用途。"
                        f"当前原始口播实测 {measured_duration:.2f} 秒，默认交付 {delivery_speed:.1f}x 后约 {delivered:.2f} 秒；"
                        f"用户需要交付不少于 {lower:.0f} 秒，可以自然多 15–30 秒。"
                        f"请{direction}，优先落在 {lower:.0f}–{upper:.0f} 秒这个宽松窗口。"
                        f"按本次真实语速换算，当前约 {effective_chars} 个有效字符；复核稿建议约 {target_chars} 个，"
                        f"可在 {lower_chars}–{upper_chars} 个有效字符间自然调整。这个区间只校准总口播时长，"
                        f"不是镜头、节奏或句式约束。{character_boundary}；请在返回前自行复核。"
                        "必须保留原口播的主题、事实、结论、语气和所有明确列举项；"
                        "不添加无关套话，不同义反复，不输出说明。必须调用唯一工具。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({
                        "title": plan.get("title") or "",
                        "audience": plan.get("audience") or "",
                        "tone": plan.get("tone") or "",
                        "core_message": plan.get("core_message") or "",
                        "narration": current,
                    }, ensure_ascii=False),
                },
            ],
            "tools": [tool],
            "tool_choice": "required",
            "temperature": 0.16,
            "thinking": {"type": settings.llm_thinking},
            "reasoning_split": True,
            "max_completion_tokens": max(8000, settings.llm_max_completion_tokens),
        }
        data = await _post_llm_json_with_retry(payload, label="MiniMax-M3口播真实时长复核")
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("口播真实时长复核没有返回可用消息") from exc
        call = self._tool_call(message)
        if not call or call[0] != "revise_narration_duration":
            raise ProviderError("口播真实时长复核没有返回结构化结果")
        revised = str(call[1].get("narration") or "").strip()
        if not revised:
            raise ProviderError("口播真实时长复核返回了空文本")
        return revised

    async def lock_timed_visual_plan(
        self,
        plan: dict[str, Any],
        narration_duration: float,
        *,
        _correction_budget: int = 2,
    ) -> dict[str, Any]:
        """Run the timed visual-editor stage after narration is measured.

        This mirrors OpenMontage's artifact boundary: the first director owns
        the story and narration, while this pass owns the executable scene
        plan against the real audio timeline.  It never rewrites narration or
        changes attachment roles.
        """
        if not settings.llm_api_key:
            raise ProviderError("MiniMax-M3 API Key 未配置")
        narration = str(plan.get("narration") or "").strip()
        if not narration:
            raise ProviderError("真实时序分镜缺少口播内容")
        duration = max(0.5, float(narration_duration or 0.5))
        # Keep a margin below the provider's 15-second technical ceiling so
        # measured narration does not later force one logical scene to be
        # cloned into several near-identical render units.
        minimum_units = max(1, int(math.ceil(duration / 12.0)))
        scene_schema = {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "duration_sec": {"type": "number", "minimum": 4, "maximum": 15},
                "visual_prompt": {
                    "type": "string",
                    "description": "只含可见主体、环境、动作、机位、光线和空间变化的纯视觉 Seedance 提示词；不得包含口播原句、字幕或花字。操作证据真正必要时可写一个短界面标签。",
                },
                "narration_excerpt": {
                    "type": "string",
                    "description": "从完整口播按顺序原样连续摘取的本段范围，仅供内部对齐，不会提交给视频模型。",
                },
                "visual_beats": {
                    "type": "array",
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "properties": {
                            "narration_anchor": {"type": "string"},
                            "visual_action": {
                                "type": "string",
                                "description": "纯视觉动作，不复述口播，不要求生成文字。",
                            },
                            "camera": {"type": "string"},
                            "transition": {"type": "string"},
                            "shot_intent": {"type": "string"},
                            "pace": {
                                "type": "string",
                                "enum": ["flash", "quick", "hold", "release"],
                            },
                            "transition_reason": {"type": "string"},
                        },
                        "required": ["narration_anchor", "visual_action"],
                    },
                },
                "narrative_role": {"type": "string"},
                "shot_intent": {"type": "string"},
                "visual_identity": {
                    "type": "string",
                    "description": "本段相对全片其他段落独有的主体、动作、空间关系或视角信息。",
                },
                "purpose": {"type": "string"},
            },
            "required": [
                "title",
                "duration_sec",
                "visual_prompt",
                "narration_excerpt",
                "visual_beats",
                "narrative_role",
                "shot_intent",
                "visual_identity",
                "purpose",
            ],
        }
        tool = {
            "type": "function",
            "function": {
                "name": "lock_timed_visual_plan",
                "description": "根据已测量的真实口播时长锁定可执行且不重复的纯视觉分镜与素材时间点。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "scenes": {
                            "type": "array",
                            "minItems": minimum_units,
                            "maxItems": 60,
                            "items": scene_schema,
                        },
                        "asset_placements": {
                            "type": "array",
                            "maxItems": 8,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "asset_id": {"type": "string"},
                                    "scene_number": {"type": "integer", "minimum": 1},
                                    "narration_anchor": {"type": "string"},
                                    "presentation": {
                                        "type": "string",
                                        "enum": ["overlay", "pip", "cutaway"],
                                    },
                                    "position": {
                                        "type": "string",
                                        "enum": ["top-left", "top-right", "bottom-left", "bottom-right", "center"],
                                    },
                                    "scale": {"type": "number", "minimum": 0.1, "maximum": 0.65},
                                    "duration_sec": {"type": "number", "minimum": 0.5},
                                    "reason": {"type": "string"},
                                },
                                "required": [
                                    "asset_id",
                                    "scene_number",
                                    "narration_anchor",
                                    "presentation",
                                    "position",
                                    "scale",
                                    "duration_sec",
                                    "reason",
                                ],
                            },
                        },
                        "public_summary": {"type": "string"},
                    },
                    "required": ["scenes", "asset_placements", "public_summary"],
                },
            },
        }
        slim_plan = {
            key: plan.get(key)
            for key in ("title", "aspect_ratio", "audience", "tone", "core_message", "narration")
        }
        slim_plan["draft_scenes"] = plan.get("scenes") or []
        if plan.get("visual_quality_feedback"):
            slim_plan["visual_quality_feedback"] = plan.get("visual_quality_feedback")
        slim_plan["assets"] = [
            {
                key: item.get(key)
                for key in (
                    "asset_id", "label", "name", "role", "presentation",
                    "scene_number", "narration_anchor", "reason",
                )
            }
            for item in (plan.get("asset_assignments") or [])
            if isinstance(item, dict)
        ]
        system = (
            "你是视频工坊的时序视觉导演。故事、口播和附件用途已经锁定；你只负责依据真实音频时长重做可执行视觉分镜。"
            "像专业剪辑流程一样，先逐段理解口播新增的信息、情绪和证据，再决定画面与节奏，不按标点、固定秒数或固定公式切分。"
            f"真实口播为 {duration:.3f} 秒；Seedance 单个技术单元最长 15 秒，因此至少需要 {minimum_units} 个可独立生成的 scene，"
            "但最终数量和每段内部节拍由表达需要决定。每个 scene 必须承接连续且不重叠的口播范围，全部 scenes 按顺序覆盖完整口播。"
            "每个 scene 必须有独立视觉身份；连续性可保留人物和世界观，但主体动作、空间职责、构图或机位不能只是上一段轻微改色改景别。"
            "不要连续使用卡片高亮、UI 列表、同一办公室、同一人物操作电脑或同一种信息图。抽象概念要发散为具体人物、物件、动作、因果、对比或有意义的隐喻。"
            "visual_prompt 和 visual_action 只描述视频模型应生成的可见内容，不得出现口播原句，也不得要求生成字幕、花字或跟随口播的文案层。"
            "真实产品操作证据需要时，允许一个导演明确指定的短按钮名或状态标签；不扩展为长文字。"
            "专有名词、技能名和抽象概念要转译为具体可见行为和结果，不把口播名称本身整段搬进画面。"
            "narration_excerpt 与 narration_anchor 只用于内部语义对齐。附件角色不可更改：只有明确要求角标/水印的 Logo 才固定 overlay；"
            "品牌被口播点名时，真实 Logo 应作为 reference/both 留在对应语义 scene，中心揭示、全屏素材或 overlay 由叙事决定。需要看清的步骤、截图或证据优先 cutaway；"
            "只有必须同时看主画面和素材关系时用 pip。每个素材默认只出现一次，并放在语义最强的口播锚点。"
            "返回前逐项核对相邻与全局提示词，消除高相似模板、重复素材和错位锚点。必须调用唯一工具，不输出普通文本。"
        )
        payload = {
            "model": settings.llm_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(slim_plan, ensure_ascii=False)},
            ],
            "tools": [tool],
            "tool_choice": "required",
            "temperature": 0.22,
            "thinking": {"type": settings.llm_thinking},
            "reasoning_split": True,
            "max_completion_tokens": max(16000, settings.llm_max_completion_tokens),
        }
        data = await _post_llm_json_with_retry(payload, label="MiniMax-M3时序视觉导演", timeout=210)
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("时序视觉导演没有返回可用消息") from exc
        call = self._tool_call(message)
        if not call or call[0] != "lock_timed_visual_plan":
            raise ProviderError("时序视觉导演没有返回结构化分镜")
        result = call[1]
        scenes = [item for item in result.get("scenes") or [] if isinstance(item, dict)]
        available_units = sum(
            max(1, len([beat for beat in list(scene.get("visual_beats") or []) if isinstance(beat, dict)]))
            for scene in scenes
        )
        if available_units < minimum_units:
            if _correction_budget > 0:
                correction_plan = {
                    **plan,
                    "visual_quality_feedback": (
                        f"上一版只有 {available_units} 个可独立执行的视觉节拍，但 {duration:.1f} 秒真实口播至少需要 "
                        f"{minimum_units} 个可独立执行的技术片段才不会超过单段 15 秒上限。"
                        "保留叙事智能与快慢变化，仅修正技术片段数和对应口播范围，必须完整返回工具参数。"
                    ),
                }
                return await self.lock_timed_visual_plan(
                    correction_plan,
                    duration,
                    _correction_budget=_correction_budget - 1,
                )
            raise ProviderError(
                f"时序视觉导演只返回 {available_units} 个可执行视觉节拍，无法覆盖 {duration:.1f} 秒真实口播"
            )
        fallback_excerpts = _partition_narration_excerpts(narration, len(scenes))
        cursor = 0
        exact_excerpts: list[str] = []
        used_fallback_excerpts = False
        for scene in scenes:
            excerpt = str(scene.get("narration_excerpt") or "")
            position = narration.find(excerpt, cursor) if excerpt else -1
            if position < cursor:
                exact_excerpts = fallback_excerpts
                used_fallback_excerpts = True
                break
            # Attach a model-skipped punctuation/gap to the current scene so
            # the audio timeline remains lossless without rewriting speech.
            exact_excerpts.append(narration[cursor:position] + excerpt)
            cursor = position + len(excerpt)
        if len(exact_excerpts) != len(scenes):
            exact_excerpts = fallback_excerpts
            used_fallback_excerpts = True
        elif not used_fallback_excerpts and cursor < len(narration):
            exact_excerpts[-1] += narration[cursor:]
        normalized: list[dict[str, Any]] = []
        invalid_prompt_scenes: list[int] = []
        for index, (scene, excerpt) in enumerate(zip(scenes, exact_excerpts), start=1):
            prompt = _sanitize_seedance_visual_text(scene.get("visual_prompt") or "")
            if len(prompt) < 20:
                invalid_prompt_scenes.append(index)
                prompt = _sanitize_seedance_visual_text(
                    "。".join(filter(None, [
                        str(scene.get("visual_identity") or ""),
                        str(scene.get("shot_intent") or ""),
                        str(scene.get("purpose") or ""),
                    ]))
                )
            if len(prompt) < 20:
                prompt = self._fallback_safe_rewrite(plan, index)["visual_prompt"]
            beats: list[dict[str, str]] = []
            for raw in list(scene.get("visual_beats") or [])[:8]:
                if not isinstance(raw, dict):
                    continue
                action = _sanitize_seedance_visual_text(raw.get("visual_action") or "")
                if not action:
                    continue
                anchor = str(raw.get("narration_anchor") or "").strip()
                if not anchor or anchor not in excerpt:
                    anchor = excerpt[:32]
                beats.append({
                    "narration_anchor": anchor[:160],
                    "visual_action": action[:600],
                    "camera": _sanitize_seedance_visual_text(raw.get("camera") or "")[:240],
                    "transition": _sanitize_seedance_visual_text(raw.get("transition") or "")[:240],
                    "shot_intent": str(raw.get("shot_intent") or "")[:300],
                    "pace": str(raw.get("pace") or "") if str(raw.get("pace") or "") in {"flash", "quick", "hold", "release"} else "",
                    "transition_reason": str(raw.get("transition_reason") or "")[:300],
                })
            normalized.append({
                "title": str(scene.get("title") or f"镜头 {index}")[:120],
                "duration_sec": max(4, min(15, _safe_float(scene.get("duration_sec"), 8))),
                "visual_prompt": prompt[:2600],
                "narration_excerpt": excerpt[:1600],
                "visual_beats": beats,
                "narrative_role": str(scene.get("narrative_role") or "推进叙事")[:160],
                "shot_intent": str(scene.get("shot_intent") or scene.get("purpose") or "推进当前表达")[:300],
                "visual_identity": _sanitize_seedance_visual_text(scene.get("visual_identity") or "")[:300],
                "purpose": str(scene.get("purpose") or "推进当前叙事")[:300],
            })
        duplicate_pairs: list[tuple[int, int, float]] = []
        for right_index, right in enumerate(normalized):
            for left_index, left in enumerate(normalized[:right_index]):
                left_visual = "\n".join([
                    left["visual_prompt"],
                    *[
                        str(beat.get("visual_action") or "")
                        for beat in left.get("visual_beats") or []
                        if isinstance(beat, dict)
                    ],
                ])
                right_visual = "\n".join([
                    right["visual_prompt"],
                    *[
                        str(beat.get("visual_action") or "")
                        for beat in right.get("visual_beats") or []
                        if isinstance(beat, dict)
                    ],
                ])
                similarity = _visual_prompt_similarity(left_visual, right_visual)
                shared_templates = (
                    _visual_template_signature(left_visual)
                    & _visual_template_signature(right_visual)
                )
                identity_similarity = _visual_prompt_similarity(
                    left.get("visual_identity") or "",
                    right.get("visual_identity") or "",
                )
                if (
                    similarity >= 0.68
                    or identity_similarity >= 0.62
                    # Generic production grammar such as "real UI" plus
                    # "desk/computer" can legitimately recur in a product
                    # tutorial. Treat a shared template set as duplication
                    # only when the actual visual content is also materially
                    # similar; otherwise the guard itself flattens the
                    # director's useful continuity.
                    or (
                        len(shared_templates) >= 2
                        and (similarity >= 0.60 or identity_similarity >= 0.60)
                    )
                ):
                    duplicate_pairs.append((left_index + 1, right_index + 1, similarity))
        speech_lengths = [
            max(1, len(re.sub(r"[\s，。！？!?；;：:,]", "", item["narration_excerpt"])))
            for item in normalized
        ]
        planned_lengths = [max(0.1, float(item.get("duration_sec") or 8)) for item in normalized]
        speech_total = sum(speech_lengths)
        planned_total = sum(planned_lengths)
        estimated_windows = [
            duration * (
                0.78 * (speech_length / speech_total)
                + 0.22 * (planned_length / planned_total)
            )
            for speech_length, planned_length in zip(speech_lengths, planned_lengths)
        ]
        overflow_scenes = [
            index + 1
            for index, (window, scene) in enumerate(zip(estimated_windows, normalized))
            if window > 15.0
            and len(scene.get("visual_beats") or []) < int(math.ceil(window / 15.0))
        ]
        if duplicate_pairs or overflow_scenes or invalid_prompt_scenes:
            detail = "、".join(
                f"{left}/{right}({score:.2f})" for left, right, score in duplicate_pairs[:5]
            )
            if _correction_budget > 0:
                problems = []
                if detail:
                    problems.append(f"高度相似镜头 {detail}")
                if overflow_scenes:
                    problems.append(
                        "真实时间窗会超过单段上限的镜头 "
                        + "、".join(str(item) for item in overflow_scenes[:8])
                    )
                if invalid_prompt_scenes:
                    problems.append(
                        "缺少完整纯视觉提示词的镜头 "
                        + "、".join(str(item) for item in invalid_prompt_scenes[:8])
                    )
                correction_plan = {
                    **plan,
                    "scenes": normalized,
                    "visual_quality_feedback": (
                        "上一版存在" + "；".join(problems) + "。保留口播范围和叙事职责，"
                        "将过长范围拆成新的独立视觉段，并重做相似段落的主体动作、空间关系、"
                        "构图或镜头运动；不得只换技能名、颜色、卡片内容或景别。"
                    ),
                }
                return await self.lock_timed_visual_plan(
                    correction_plan,
                    duration,
                    _correction_budget=_correction_budget - 1,
                )
            unresolved = []
            if detail:
                unresolved.append(f"高度相似镜头 {detail}")
            if overflow_scenes:
                unresolved.append(
                    "超长镜头 " + "、".join(str(item) for item in overflow_scenes[:8])
                )
            if invalid_prompt_scenes:
                unresolved.append(
                    "无效纯视觉提示词镜头 "
                    + "、".join(str(item) for item in invalid_prompt_scenes[:8])
                )
            raise ProviderError("时序视觉导演仍存在" + "；".join(unresolved))
        placements = [item for item in result.get("asset_placements") or [] if isinstance(item, dict)]
        return {
            "scenes": normalized,
            "asset_placements": placements,
            "public_summary": str(result.get("public_summary") or "已按真实口播时长重新锁定独立视觉分镜。")[:300],
            "actual_duration": duration,
            "minimum_units": minimum_units,
        }

    async def decide(
        self,
        messages: list[dict[str, Any]],
        aspect_ratio: str,
        attachments: list[dict[str, Any]],
        skill_context: str = "",
        bgm_catalog: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        if not settings.llm_api_key:
            raise ProviderError("MiniMax-M3 API Key 未配置")

        requested_duration_sec = _explicit_duration_seconds(messages)
        api_messages: list[dict[str, Any]] = [
            {
                "role": "system",
                "content": self._system_prompt(
                    aspect_ratio,
                    skill_context,
                    bgm_catalog or [],
                    requested_duration_sec,
                ),
            }
        ]
        for message in messages[-12:]:
            role = message.get("role")
            if role not in {"user", "assistant"}:
                continue
            api_messages.append({"role": role, "content": str(message.get("content") or "")})

        if attachments and api_messages and api_messages[-1]["role"] == "user":
            manifest_lines = ["附件清单（用户提到图N、视频N或音频N时以这里为准）："]
            for item in attachments[:8]:
                duration = f"，时长约 {item.get('duration')} 秒" if item.get("duration") else ""
                transcript = str((item.get("transcript") or {}).get("text") or "").strip()
                transcript_note = f"，口播转写={transcript[:3000]}" if transcript else ""
                manifest_lines.append(
                    f"- {item.get('label')} | asset_id={item.get('asset_id')} | "
                    f"{item.get('media_type')} | 文件名={item.get('name')}{duration}{transcript_note}"
                )
            combined_text = f"{api_messages[-1]['content']}\n\n" + "\n".join(manifest_lines)
            blocks: list[dict[str, Any]] = [{"type": "text", "text": combined_text}]
            for item in attachments[:8]:
                data_url = str(item.get("visionDataUrl") or "")
                if data_url.startswith("data:image/") and len(data_url) <= 8_500_000:
                    blocks.append({"type": "text", "text": f"{item.get('label')} 的视觉预览："})
                    blocks.append({"type": "image_url", "image_url": {"url": data_url}})
            api_messages[-1]["content"] = blocks

        payload = {
            "model": settings.llm_model,
            "messages": api_messages,
            "tools": self.tools,
            "tool_choice": "auto",
            "temperature": 0.25,
            "thinking": {"type": settings.llm_thinking},
            "reasoning_split": True,
            # A complete director plan contains narration, scene semantics,
            # asset mapping and intra-clip timelines.  A legacy 4k local value
            # can make an otherwise healthy M3 call end with an empty or
            # truncated tool message, so reserve a safe plan-sized budget
            # without changing any creative constraints.
            "max_completion_tokens": max(12000, settings.llm_max_completion_tokens),
        }
        data = await _post_llm_json_with_retry(payload, label="MiniMax-M3")
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("MiniMax-M3 没有返回可用消息") from exc

        call = self._tool_call(message)
        if (
            (not call or call[0] == "ask_user")
            and _director_request_has_executable_brief(messages, attachments)
        ):
            # One bounded self-correction: the creative model occasionally
            # turns optional preferences into required form fields, or writes
            # a complete production proposal as plain assistant text without
            # invoking either director tool.  Force only the action (start),
            # never its duration, style or shot plan.
            correction_messages = [
                *api_messages,
                {
                    "role": "system",
                    "content": (
                        "复核结果：用户已给出可执行的创作简报，上一次追问的是导演应自主决定的可选偏好。"
                        "现在必须调用 start_video_production，保持导演自主性，用你的最佳判断完成受众、风格、结尾、镜头与素材决策；"
                        "不要添加固定镜头数、固定时长或固定节奏。"
                    ),
                },
            ]
            corrected_payload = {
                **payload,
                "messages": correction_messages,
                # Some OpenAI-compatible gateways serialize a forced function
                # choice as literal XML.  Supplying only the production tool
                # keeps the correction unambiguous while retaining their
                # native tool-call format.
                "tools": [self.tools[1]],
                "tool_choice": "auto",
            }
            corrected_data = await _post_llm_json_with_retry(
                corrected_payload,
                label="MiniMax-M3导演自检",
            )
            try:
                message = corrected_data["choices"][0]["message"]
            except (KeyError, IndexError, TypeError) as exc:
                raise ProviderError("MiniMax-M3导演自检没有返回可用消息") from exc
            call = self._tool_call(message)
            if not call or call[0] != "start_video_production":
                final_payload = {
                    **corrected_payload,
                    "messages": [
                        *correction_messages,
                        {
                            "role": "system",
                            "content": (
                                "上一次返回未使用规定的生产工具格式。不要输出解释、XML 或追问；"
                                "仅通过唯一可用的 start_video_production 工具提交你自主完成的导演计划。"
                            ),
                        },
                    ],
                    "tool_choice": "required",
                    "temperature": 0.15,
                }
                final_data = await _post_llm_json_with_retry(
                    final_payload,
                    label="MiniMax-M3导演格式纠正",
                )
                try:
                    message = final_data["choices"][0]["message"]
                except (KeyError, IndexError, TypeError) as exc:
                    raise ProviderError("MiniMax-M3导演格式纠正没有返回可用消息") from exc
                call = self._tool_call(message)
        if not call:
            content = str(message.get("content") or "").strip()
            if content:
                return {"action": "ask", "question": content[:240], "missing": ["模型未调用导演工具"]}
            raise ProviderError("MiniMax-M3 未调用导演工具")

        name, arguments = call
        if name == "ask_user":
            question = str(arguments.get("question") or "").strip()
            suggestions = [str(item)[:80] for item in list(arguments.get("suggestions") or []) if str(item).strip()][:3]
            if len(suggestions) < 2:
                suggestions = (
                    ["按你的判断自动分配", "图片只作生成参考", "把上传素材剪进成片"]
                    if attachments
                    else ["按你的建议继续", "我补充目标受众", "我补充画面要求"]
                )
            return {
                "action": "ask",
                "question": question[:240] or "你最想让观众记住哪一句话？",
                "missing": arguments.get("missing") or [],
                "suggestions": suggestions,
            }
        if name != "start_video_production":
            raise ProviderError(f"MiniMax-M3 调用了未知工具：{name}")

        # A stated duration is a one-way floor. Keep the longest valid plan
        # across bounded self-corrections so a bad retry can never shorten an
        # otherwise useful narration. Script/audio modes remain verbatim; real
        # TTS duration is still the authoritative timeline in the pipeline.
        minimum_target_chars = _duration_character_floor(requested_duration_sec)
        best_arguments = arguments
        best_effective_chars = len(re.sub(
            r"[\s，。！？!?；;：:,、（）()《》“”‘’\-—…]",
            "",
            str(arguments.get("narration") or "").strip(),
        ))
        for _correction_index in range(3):
            preliminary_narration = str(arguments.get("narration") or "").strip()
            preliminary_mode = str(arguments.get("input_mode") or "topic")
            needs_duration_correction = bool(
                requested_duration_sec
                and preliminary_mode == "topic"
                and preliminary_narration
                and best_effective_chars < minimum_target_chars
            )
            if not needs_duration_correction:
                break
            corrected_payload = {
                **payload,
                "messages": [
                    *api_messages,
                    {
                        "role": "system",
                        "content": (
                            f"时长下限复核：用户要求最终成片不少于 {requested_duration_sec} 秒，"
                            f"发布版默认 1.2x；目前最完整版只有 {best_effective_chars} 个有效字符，仍可能偏短。"
                            f"必须保留下面最完整版的所有事实、叙事和附件用途，只通过增加有用的细节、例子、证据或转折自然扩充，"
                            f"使口播信息量不少于约 {minimum_target_chars} 个有效字符。不要删减、不要压缩、不要同义反复，"
                            "同时重新匹配完整场景计划。仅调用 start_video_production。最完整版结构参考："
                            + json.dumps(best_arguments, ensure_ascii=False)[:18000]
                        ),
                    },
                ],
                "tools": [self.tools[1]],
                "tool_choice": "required",
                "temperature": 0.2,
            }
            corrected_data = await _post_llm_json_with_retry(
                corrected_payload,
                label="MiniMax-M3口播时长复核",
            )
            try:
                corrected_message = corrected_data["choices"][0]["message"]
            except (KeyError, IndexError, TypeError) as exc:
                raise ProviderError("MiniMax-M3口播时长复核没有返回可用消息") from exc
            corrected_call = self._tool_call(corrected_message)
            if corrected_call and corrected_call[0] == "start_video_production":
                arguments = corrected_call[1]
                candidate_chars = len(re.sub(
                    r"[\s，。！？!?；;：:,、（）()《》“”‘’\-—…]",
                    "",
                    str(arguments.get("narration") or "").strip(),
                ))
                if candidate_chars > best_effective_chars:
                    best_arguments = arguments
                    best_effective_chars = candidate_chars
            else:
                break
        arguments = best_arguments

        supported_ratios = {"9:16", "16:9", "1:1", "4:3", "3:4", "21:9"}
        arguments["aspect_ratio"] = aspect_ratio if aspect_ratio in supported_ratios else "9:16"
        narration = str(arguments.get("narration") or "").strip()
        if not narration:
            raise ProviderError("导演计划缺少口播内容")
        arguments["narration"] = narration
        scenes = [scene for scene in list(arguments.get("scenes") or []) if isinstance(scene, dict)]
        if not scenes:
            raise ProviderError("导演计划必须包含至少一个可执行镜头")
        fallback_excerpts = _partition_narration_excerpts(narration, len(scenes))
        provided_excerpts = [str(scene.get("narration_excerpt") or "").strip() for scene in scenes]
        cursor = 0
        ordered_excerpts: list[str] = []
        for excerpt in provided_excerpts:
            position = narration.find(excerpt, cursor) if excerpt else -1
            # Ordered but gapped excerpts are still unsafe: they silently drop
            # words from the visual timeline.  Require exact contiguity and
            # fall back to deterministic, punctuation-aware full coverage.
            if position != cursor:
                ordered_excerpts = fallback_excerpts
                break
            ordered_excerpts.append(excerpt)
            cursor = position + len(excerpt)
        if len(ordered_excerpts) != len(scenes) or cursor != len(narration):
            ordered_excerpts = fallback_excerpts
        for index, scene in enumerate(scenes):
            scene["title"] = str(scene.get("title") or f"镜头 {index + 1}")[:120]
            scene["duration_sec"] = max(4, min(15, _safe_int(scene.get("duration_sec"), 8)))
            scene["visual_prompt"] = str(scene.get("visual_prompt") or "").strip()
            scene["purpose"] = str(scene.get("purpose") or "推进当前叙事")[:300]
            scene["narrative_role"] = str(scene.get("narrative_role") or "推进叙事").strip()[:160]
            scene["shot_intent"] = str(scene.get("shot_intent") or scene["purpose"]).strip()[:300]
            excerpt = ordered_excerpts[index]
            scene["narration_excerpt"] = excerpt[:1200]
            beats: list[dict[str, str]] = []
            for raw_beat in list(scene.get("visual_beats") or [])[:8]:
                if not isinstance(raw_beat, dict):
                    continue
                action = str(raw_beat.get("visual_action") or "").strip()
                if not action:
                    continue
                anchor = str(raw_beat.get("narration_anchor") or "").strip()
                if not anchor or anchor not in scene["narration_excerpt"]:
                    anchor = scene["narration_excerpt"][:32]
                beats.append({
                    "narration_anchor": anchor[:160],
                    "visual_action": action[:600],
                    "camera": str(raw_beat.get("camera") or "").strip()[:240],
                    "transition": str(raw_beat.get("transition") or "").strip()[:240],
                    "shot_intent": str(raw_beat.get("shot_intent") or "").strip()[:300],
                    "pace": str(raw_beat.get("pace") or "").strip()[:32]
                    if str(raw_beat.get("pace") or "").strip() in {"flash", "quick", "hold", "release"}
                    else "",
                    "transition_reason": str(raw_beat.get("transition_reason") or "").strip()[:300],
                })
            scene["visual_beats"] = beats
            if not scene["visual_prompt"]:
                reconstructed = _sanitize_seedance_visual_text("。".join(filter(None, [
                    str(scene.get("visual_identity") or ""),
                    str(scene.get("shot_intent") or ""),
                    str(scene.get("purpose") or ""),
                    *[str(beat.get("visual_action") or "") for beat in beats],
                ])))
                scene["visual_prompt"] = (
                    reconstructed
                    if len(reconstructed) >= 20
                    else self._fallback_safe_rewrite(arguments, index + 1)["visual_prompt"]
                )
        # Preserve director freedom, but do not silently lose an explicit
        # audience enumeration.  This fallback only fills concepts the model
        # omitted; it never changes scene count, timing, style or camera plan.
        auto_visual_concepts: list[str] = []
        visual_text = "\n".join(
            value
            for scene in scenes
            for value in [
                str(scene.get("visual_prompt") or ""),
                *[
                    str(beat.get("visual_action") or "")
                    for beat in scene.get("visual_beats") or []
                    if isinstance(beat, dict)
                ],
            ]
        )
        original_brief = next(
            (str(item.get("content") or "") for item in reversed(messages) if item.get("role") == "user"),
            "",
        )
        for concept in _explicit_audience_enumerations(f"{narration}\n{original_brief}"):
            if concept in visual_text:
                continue
            target = next(
                (scene for scene in scenes if concept in str(scene.get("narration_excerpt") or "")),
                next(
                    (
                        scene
                        for scene in scenes
                        if re.search(
                            r"人群|用户|受众|适合",
                            f"{scene.get('title') or ''} {scene.get('visual_prompt') or ''}",
                        )
                    ),
                    scenes[min(len(scenes) - 1, max(0, len(scenes) // 2))],
                ),
            )
            target_excerpt = str(target.get("narration_excerpt") or "")
            target.setdefault("visual_beats", []).append({
                "narration_anchor": concept if concept in target_excerpt else target_excerpt[:32],
                "visual_action": f"画面明确呈现{concept}在其真实使用场景中的具体动作，与当前口播同步出现。",
                "camera": "用与前后人群不同的环境、景别或动作识别该人群。",
                "transition": "跟随口播列举自然推进。",
            })
            auto_visual_concepts.append(concept)
            visual_text += f"\n{concept}"
        arguments["scenes"] = scenes
        planned_duration = sum(int(scene["duration_sec"]) for scene in scenes)
        arguments["duration_sec"] = max(1, _safe_int(arguments.get("duration_sec"), planned_duration))
        public_thoughts = list(arguments.get("public_thoughts") or [])[:8]
        if not public_thoughts:
            public_thoughts = [
                {
                    "title": "按内容决定节奏",
                    "detail": f"方案使用 {len(scenes)} 个镜头承接口播，镜头数量和时长服务于完整表达。",
                },
            ]
        arguments["public_thoughts"] = [
            {
                "title": str(item.get("title") or "导演判断")[:80],
                "detail": str(item.get("detail") or "")[:260],
            }
            for item in public_thoughts
            if isinstance(item, dict)
        ]
        covered = sum(len(str(scene.get("narration_excerpt") or "")) for scene in scenes)
        arguments["director_alignment"] = {
            "scene_count": len(scenes),
            "visual_beat_count": sum(len(scene.get("visual_beats") or []) for scene in scenes),
            "narration_coverage_ratio": round(min(1.0, covered / max(1, len(narration))), 3),
            "auto_visual_concepts": auto_visual_concepts,
        }
        input_mode = _explicit_input_mode(messages)
        arguments["input_mode"] = input_mode
        if requested_duration_sec:
            arguments["requested_duration_sec"] = requested_duration_sec
        latest_user_text = next(
            (str(item.get("content") or "") for item in reversed(messages) if item.get("role") == "user"),
            "",
        )
        explicit_no_bgm = bool(re.search(
            r"(?:不要|不用|不加|关闭|移除|去掉).{0,6}(?:BGM|bgm|配乐|背景音乐|音乐)|无\s*(?:BGM|bgm|配乐|背景音乐)|纯口播",
            latest_user_text,
        ))
        raw_audio_design = arguments.get("audio_design") if isinstance(arguments.get("audio_design"), dict) else {}
        arguments["audio_design"] = {
            "bgm_enabled": bool(bgm_catalog) and not explicit_no_bgm,
            "bgm_mood": str(raw_audio_design.get("bgm_mood") or arguments.get("tone") or "克制")[:120],
            "bgm_track_id": str(raw_audio_design.get("bgm_track_id") or "")[:120],
            "bgm_volume": max(0.03, min(0.3, _safe_float(raw_audio_design.get("bgm_volume"), 0.12))),
            "sound_note": str(raw_audio_design.get("sound_note") or "保持口播清晰，音乐只承担氛围。")[:300],
        }
        explicit_roles: dict[str, set[str]] = {}
        for match in re.finditer(
            r"((?:(?:图|视频|音频)\s*\d+\s*[、,，和及与/ ]*)+)\s*(?:是|作为|用作|当作)?\s*(参考|素材|剪辑|插入|成片|口播|旁白|配乐|背景音乐|音效)",
            latest_user_text,
        ):
            marker = match.group(2)
            if marker == "参考":
                role = "reference"
            elif marker in {"口播", "旁白"}:
                role = "narration"
            elif marker in {"配乐", "背景音乐"}:
                role = "bgm"
            elif marker == "音效":
                role = "sfx"
            else:
                role = "material"
            for label in re.findall(r"(?:图|视频|音频)\s*\d+", match.group(1)):
                normalized_label = re.sub(r"\s+", "", label)
                explicit_roles.setdefault(normalized_label, set()).add(role)

        # Keep explicit, numbered user instructions authoritative even when the
        # director's otherwise useful creative plan assigns a different role.
        # This only normalizes attachment purpose; placement and timing remain
        # the director's decision unless the user also names a scene below.
        compact_user_text = re.sub(r"\s+", "", latest_user_text)
        explicit_logo_overlays = _explicit_logo_overlay_labels(latest_user_text, attachments)
        for clause in re.split(r"[，,。；;！!？?\n]+", compact_user_text):
            labels = [re.sub(r"\s+", "", item) for item in re.findall(r"(?:图|视频|音频)\s*\d+", clause)]
            if not labels:
                continue
            if re.search(r"参考|作为.*(?:生成|视频).*参考", clause):
                for label in labels:
                    explicit_roles.setdefault(label, set()).add("reference")
            if re.search(r"剪辑素材|作为.*素材|插入|放到.*(?:位置|镜头|地方|合适)", clause):
                for label in labels:
                    explicit_roles.setdefault(label, set()).add("material")

        if re.search(r"(?:其他|其余|剩下|余下)(?:的)?(?:图片|图).*?(?:剪辑素材|作为素材|放到合适)", compact_user_text):
            explicit_reference_labels = {
                label for label, roles in explicit_roles.items() if "reference" in roles
            }
            for asset in attachments:
                if str(asset.get("media_type") or "") != "image":
                    continue
                label = re.sub(r"\s+", "", str(asset.get("label") or ""))
                if label and label not in explicit_reference_labels:
                    explicit_roles.setdefault(label, set()).add("material")

        scene_count = len(scenes)
        explicit_scenes: dict[str, int] = {}
        for clause in re.split(r"[，,。；;\n]+", latest_user_text):
            labels = [re.sub(r"\s+", "", item) for item in re.findall(r"(?:图|视频|音频)\s*\d+", clause)]
            if not labels:
                continue
            scene_number = 0
            numeric_match = re.search(r"(?:第\s*)?(\d+)\s*(?:段|镜头)", clause)
            if numeric_match:
                scene_number = _safe_int(numeric_match.group(1), 0)
            else:
                chinese_numbers = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
                chinese_match = re.search(r"(?:第\s*)?([一二三四五六七八九十])\s*(?:段|镜头)", clause)
                if chinese_match:
                    scene_number = chinese_numbers[chinese_match.group(1)]
            if scene_number:
                explicit_scenes.update({label: max(1, min(scene_count, scene_number)) for label in labels})

        raw_assignments = [item for item in list(arguments.get("asset_assignments") or []) if isinstance(item, dict)]
        by_id = {str(item.get("asset_id") or ""): item for item in raw_assignments}
        by_label = {re.sub(r"\s+", "", str(item.get("label") or "")): item for item in raw_assignments}
        normalized_assignments = []
        narration_selected = False
        for index, asset in enumerate(attachments):
            label = re.sub(r"\s+", "", str(asset.get("label") or ""))
            item = by_id.get(str(asset.get("asset_id") or "")) or by_label.get(label) or {}
            media_type = str(asset.get("media_type") or "")
            has_transcript = bool((asset.get("transcript") or {}).get("text"))
            # A missing assignment is not permission to inject an image into
            # every generated shot. The model must select reference/material
            # intentionally, or the user's numbered instruction below must do
            # so explicitly.
            default_role = "unused" if media_type == "image" else "material" if media_type == "video" else "narration" if has_transcript else "unused"
            role = str(item.get("role") or default_role)
            explicit = explicit_roles.get(label) or set()
            if explicit == {"reference", "material"}:
                role = "both"
            elif explicit:
                role = next(iter(explicit))
            allowed_roles = {
                "image": {"reference", "material", "both", "unused"},
                "video": {"material", "unused"},
                "audio": {"narration", "bgm", "sfx", "unused"},
            }.get(media_type, {"unused"})
            if role not in allowed_roles:
                role = default_role
            if role == "narration":
                if narration_selected:
                    role = "sfx"
                else:
                    narration_selected = True
            default_scene = index % scene_count + 1
            scene_value = explicit_scenes.get(label, _safe_int(item.get("scene_number"), default_scene))
            is_logo = _is_logo_asset(asset)
            presentation = str(item.get("presentation") or "auto")
            if presentation not in {"auto", "overlay", "pip", "cutaway"}:
                presentation = "auto"
            if is_logo and label in explicit_logo_overlays:
                presentation = "overlay"
            elif presentation == "auto":
                # The director has already classified this as material.  Show
                # evidence-bearing image/video assets at their semantic beat,
                # instead of silently demoting them to a tiny PIP window.
                presentation = "cutaway"
            position = str(item.get("position") or ("top-right" if presentation == "overlay" else "center"))
            if position not in {"top-left", "top-right", "bottom-left", "bottom-right", "center"}:
                position = "top-right" if presentation == "overlay" else "center"
            default_scale = 0.22 if is_logo and presentation == "overlay" else 0.36
            if is_logo and label in explicit_logo_overlays:
                if position == "center":
                    position = "top-right"
                default_scale = 0.22
            normalized_assignments.append(
                {
                    "asset_id": str(asset.get("asset_id") or ""),
                    "label": label,
                    "role": role,
                    "presentation": presentation,
                    "position": position,
                    "scale": max(0.1, min(0.65, _safe_float(item.get("scale"), default_scale))),
                    "scene_number": max(1, min(scene_count, scene_value)),
                    "narration_anchor": str(item.get("narration_anchor") or "")[:80],
                    "duration_sec": max(0.5, _safe_float(item.get("duration_sec"), 3.6)),
                    "source_start_sec": max(0.0, _safe_float(item.get("source_start_sec"), 0.0)),
                    "volume": max(0.0, min(1.5, _safe_float(item.get("volume"), 0.72 if role == "sfx" else 1.0))),
                    "reason": str(item.get("reason") or "根据用户描述和附件类型自动分配")[:220],
                }
            )
        arguments["asset_assignments"] = normalized_assignments
        narration_assignment = next(
            (item for item in normalized_assignments if item.get("role") == "narration"),
            None,
        )
        if narration_assignment:
            narration_asset = next(
                (
                    item
                    for item in attachments
                    if str(item.get("asset_id") or "") == str(narration_assignment.get("asset_id") or "")
                ),
                None,
            )
            transcript_text = str(((narration_asset or {}).get("transcript") or {}).get("text") or "").strip()
            if transcript_text:
                arguments["narration"] = transcript_text
                arguments["input_mode"] = "audio"
        return {"action": "produce", "plan": arguments}

    @staticmethod
    def _fallback_safe_rewrite(plan: dict[str, Any], scene_number: int) -> dict[str, str]:
        ratio = str(plan.get("aspect_ratio") or "9:16")
        tone = str(plan.get("tone") or "克制、高级")
        purpose = (
            "通过光体从分散到有序的变化建立效率提升主题"
            if scene_number == 1
            else "通过光体稳定汇聚完成有序收束"
        )
        prompt = (
            f"{ratio} 画幅，电影级抽象产品视觉，{tone}。"
            "画面仅由中性几何光体、光线和纯净开放空间构成，视觉元素简洁、抽象、无文字。"
            "一组中性几何光体在深色开放空间中由分散到有序地编排，"
            "光线从冷白逐步过渡到温和金色，镜头缓慢推进，动作简洁稳定，无高风险隐喻。"
            f"叙事目的：{purpose}。"
        )
        return {
            "visual_prompt": prompt,
            "change_summary": "将拟人主体改为中性几何光体，去除品牌、身份与夸张隐喻，保留原有色彩和节奏。",
            "public_thought": "审核风险主要来自拟人化与身份隐喻，本次改用抽象产品视觉表达同一效率主题。",
        }

    async def rewrite_scene_for_safety(
        self,
        plan: dict[str, Any],
        scene_number: int,
        failure_reason: str = "safety",
    ) -> dict[str, str]:
        if not settings.llm_api_key:
            return self._fallback_safe_rewrite(plan, scene_number)

        scenes = list(plan.get("scenes") or [])
        if scene_number < 1 or len(scenes) < scene_number:
            raise ProviderError("找不到需要改写的镜头")
        rewrite_tool = {
            "type": "function",
            "function": {
                "name": "rewrite_scene_prompt",
                "description": "返回安全、中性且可直接用于视频生成的替代镜头。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "visual_prompt": {"type": "string"},
                        "change_summary": {"type": "string"},
                        "public_thought": {"type": "string"},
                    },
                    "required": ["visual_prompt", "change_summary", "public_thought"],
                },
            },
        }
        failure_context = (
            "某个镜头未通过版权风险审核。新镜头必须是原创中性视觉，不得模仿任何影视、动画、游戏、艺术家或商业作品的具体风格，"
            "不得出现可识别公众人物、明星脸、知名角色、商标或受保护设计；真人只能用背影、手部、剪影或无面孔远景。"
            if failure_reason == "copyright"
            else "某个镜头未通过内容安全审核。"
        )
        system = (
            f"你是星阵视频工坊的安全与原创重写导演。{failure_context}"
            "必须调用 rewrite_scene_prompt，只改写这一个镜头。"
            "保留原镜头的叙事功能、画幅、色彩逻辑和镜头节奏；"
            "移除真实品牌、真实人名、夸张承诺、身份与权力象征，避免政治、军事、宗教、医疗、金融、监控、"
            "武器、冲突、未成年人和敏感标志。优先使用无面孔的中性主体、物件、空间、光影或几何动效；"
            "不生成可读文字、Logo 和具体 UI。visual_prompt 必须是独立完整的中文提示词，不要提到审核、失败或重试。"
            "change_summary 和 public_thought 只是可公开的决策摘要，不得输出隐藏思维链或内部实现细节。"
        )
        neighbor_index = scene_number - 2 if scene_number > 1 else (1 if len(scenes) > 1 else None)
        user_payload = {
            "aspect_ratio": plan.get("aspect_ratio"),
            "tone": plan.get("tone"),
            "scene_number": scene_number,
            "scene": scenes[scene_number - 1],
            "neighbor_scene": scenes[neighbor_index] if neighbor_index is not None else None,
        }
        payload = {
            "model": settings.llm_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            "tools": [rewrite_tool],
            "tool_choice": "auto",
            "temperature": 0.15,
            "thinking": {"type": settings.llm_thinking},
            "reasoning_split": True,
            "max_completion_tokens": min(settings.llm_max_completion_tokens, 8000),
        }
        try:
            data = await _post_llm_json_with_retry(payload, label="安全重写")
            message = data["choices"][0]["message"]
            call = self._tool_call(message)
            if not call or call[0] != "rewrite_scene_prompt":
                return self._fallback_safe_rewrite(plan, scene_number)
            arguments = call[1]
            visual_prompt = str(arguments.get("visual_prompt") or "").strip()
            blocked_terms = (
                "百度",
                "最强",
                "超级",
                "数字员工",
                "数字人",
                "人形",
                "人脸",
                "制服",
                "武器",
                "战斗",
            )
            if len(visual_prompt) < 80 or any(term in visual_prompt for term in blocked_terms):
                return self._fallback_safe_rewrite(plan, scene_number)
            if failure_reason == "copyright" and not any(
                marker in visual_prompt for marker in ("背影", "手部", "剪影", "无面孔", "远景", "几何", "物件", "抽象")
            ):
                return self._fallback_safe_rewrite(plan, scene_number)
            return {
                "visual_prompt": visual_prompt[:1800],
                "change_summary": str(arguments.get("change_summary") or "已降低视觉风险。")[:300],
                "public_thought": str(arguments.get("public_thought") or "保留叙事功能，用更中性的视觉语言重新表达。")[:360],
            }
        except (KeyError, IndexError, TypeError, ValueError, httpx.HTTPError, ProviderError):
            return self._fallback_safe_rewrite(plan, scene_number)

    async def revise_scene(
        self,
        plan: dict[str, Any],
        scene_number: int,
        instruction: str,
    ) -> dict[str, str]:
        if not settings.llm_api_key:
            raise ProviderError("导演语言模型未配置，无法局部修改镜头")
        scenes = [item for item in list(plan.get("scenes") or []) if isinstance(item, dict)]
        if scene_number < 1 or scene_number > len(scenes):
            raise ProviderError("找不到需要修改的镜头")
        tool = {
            "type": "function",
            "function": {
                "name": "revise_one_scene",
                "description": "只返回指定镜头的修订结果。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "visual_prompt": {"type": "string"},
                        "title": {"type": "string"},
                        "purpose": {"type": "string"},
                        "change_summary": {"type": "string"},
                    },
                    "required": ["visual_prompt", "title", "purpose", "change_summary"],
                },
            },
        }
        payload = {
            "model": settings.llm_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是星阵视频工坊的镜头修订导演。必须调用 revise_one_scene，"
                        "只修改用户指定的一个镜头，不改口播、总时长、画幅、其他镜头或整体事实。"
                        "新 visual_prompt 必须是可独立提交给视频模型的完整中文提示词，"
                        "执行用户意见，同时保持与相邻镜头的人物、场景、色彩、光线和运动连续。"
                        "不得输出隐藏思维链、真实密钥、夸张承诺或无法验证的事实。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "instruction": str(instruction or "")[:2000],
                            "title": str(plan.get("title") or ""),
                            "aspect_ratio": str(plan.get("aspect_ratio") or "9:16"),
                            "tone": str(plan.get("tone") or ""),
                            "narration": str(plan.get("narration") or "")[:5000],
                            "scene_number": scene_number,
                            "scene": scenes[scene_number - 1],
                            "previous_scene": scenes[scene_number - 2] if scene_number > 1 else None,
                            "next_scene": scenes[scene_number] if scene_number < len(scenes) else None,
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            "tools": [tool],
            "tool_choice": {
                "type": "function",
                "function": {"name": "revise_one_scene"},
            },
            "temperature": 0.15,
            "thinking": {"type": settings.llm_thinking},
            "reasoning_split": True,
            "max_completion_tokens": min(settings.llm_max_completion_tokens, 8000),
        }
        data = await _post_llm_json_with_retry(payload, label="镜头局部修订")
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("镜头局部修订没有返回可用消息") from exc
        call = self._tool_call(message)
        if not call or call[0] != "revise_one_scene":
            raise ProviderError("镜头局部修订没有返回结构化结果")
        arguments = call[1]
        required_text = {
            key: str(arguments.get(key) or "").strip()
            for key in ("visual_prompt", "title", "purpose", "change_summary")
        }
        if any(not value for value in required_text.values()):
            raise ProviderError("镜头局部修订返回字段不完整")
        visual_prompt = required_text["visual_prompt"]
        if len(visual_prompt) < 40:
            raise ProviderError("镜头局部修订返回的画面提示词不完整")
        return {
            "visual_prompt": visual_prompt[:2400],
            "title": required_text["title"][:120],
            "purpose": required_text["purpose"][:300],
            "change_summary": required_text["change_summary"][:300],
        }

    async def revise_subtitle_style(
        self,
        plan: dict[str, Any],
        instruction: str,
    ) -> dict[str, Any]:
        if not settings.llm_api_key:
            raise ProviderError("导演语言模型未配置，无法智能调整字幕编排")
        tool = {
            "type": "function",
            "function": {
                "name": "revise_subtitle_style",
                "description": "只返回字幕排版参数，不修改口播文字。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "font_scale": {"type": "number", "minimum": 0.7, "maximum": 1.4},
                        "vertical_position": {
                            "type": "string",
                            "enum": ["higher", "default", "lower"],
                        },
                        "max_chars": {"type": "integer", "minimum": 7, "maximum": 32},
                        "animation": {
                            "type": "string",
                            "enum": ["minimal", "dynamic"],
                        },
                        "public_summary": {"type": "string"},
                    },
                    "required": [
                        "font_scale",
                        "vertical_position",
                        "max_chars",
                        "animation",
                        "public_summary",
                    ],
                },
            },
        }
        default_max_chars = 14 if str(plan.get("aspect_ratio") or "9:16") == "9:16" else 24
        payload = {
            "model": settings.llm_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是短视频字幕排版导演。必须调用 revise_subtitle_style。"
                        "只根据用户意见调整分句密度、字号比例、垂直位置和动效；"
                        "不得改写、增删或猜测任何口播文字，不得要求重新生成视频。"
                        "参数要克制并保证手机端安全区和可读性。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "instruction": str(instruction or "")[:2000],
                            "aspect_ratio": str(plan.get("aspect_ratio") or "9:16"),
                            "current_style": plan.get("subtitle_style") or {
                                "font_scale": 1.0,
                                "vertical_position": "default",
                                "max_chars": default_max_chars,
                                "animation": "dynamic",
                            },
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
            "tools": [tool],
            "tool_choice": {
                "type": "function",
                "function": {"name": "revise_subtitle_style"},
            },
            "temperature": 0.1,
            "thinking": {"type": settings.llm_thinking},
            "reasoning_split": True,
            "max_completion_tokens": min(settings.llm_max_completion_tokens, 4000),
        }
        data = await _post_llm_json_with_retry(payload, label="字幕局部修订")
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("字幕局部修订没有返回可用消息") from exc
        call = self._tool_call(message)
        if not call or call[0] != "revise_subtitle_style":
            raise ProviderError("字幕局部修订没有返回结构化结果")
        arguments = call[1]
        required = {
            "font_scale",
            "vertical_position",
            "max_chars",
            "animation",
            "public_summary",
        }
        if not required.issubset(arguments):
            raise ProviderError("字幕局部修订返回字段不完整")
        font_scale = _safe_float(arguments.get("font_scale"), math.nan)
        max_chars_value = _safe_int(arguments.get("max_chars"), -1)
        vertical_position = str(arguments.get("vertical_position") or "")
        animation = str(arguments.get("animation") or "")
        public_summary = str(arguments.get("public_summary") or "").strip()
        if not 0.7 <= font_scale <= 1.4:
            raise ProviderError("字幕局部修订返回的字号参数无效")
        if not 7 <= max_chars_value <= 32:
            raise ProviderError("字幕局部修订返回的分句参数无效")
        if vertical_position not in {"higher", "default", "lower"}:
            raise ProviderError("字幕局部修订返回的位置参数无效")
        if animation not in {"minimal", "dynamic"}:
            raise ProviderError("字幕局部修订返回的动效参数无效")
        if not public_summary:
            raise ProviderError("字幕局部修订返回的说明为空")
        return {
            "font_scale": font_scale,
            "vertical_position": vertical_position,
            "max_chars": max_chars_value,
            "animation": animation,
            "public_summary": public_summary[:300],
        }


class MiniMaxTTS:
    async def generate(
        self,
        text: str,
        output_path: Path,
        target_duration_sec: float | None = None,
        voice_id: str | None = None,
    ) -> dict[str, Any]:
        if not settings.minimax_api_key:
            raise ProviderError("MiniMax TTS API Key 未配置")
        selected_voice_id = str(voice_id or settings.minimax_voice_id or "").strip()
        if not selected_voice_id:
            raise ProviderError("MiniMax TTS 音色 ID 未配置")
        group_id = str(getattr(settings, "minimax_group_id", "") or "").strip()
        speed = _tts_speed_for_target(text, target_duration_sec)
        payload = {
            "model": settings.minimax_tts_model,
            "text": text[:9999],
            "stream": False,
            "language_boost": "Chinese",
            "output_format": "hex",
            "voice_setting": {
                "voice_id": selected_voice_id,
                "speed": speed,
                "vol": 1,
                "pitch": 0,
            },
            "audio_setting": {
                "sample_rate": 32000,
                "bitrate": 128000,
                "format": "mp3",
                "channel": 1,
            },
        }
        async with _client(150) as client:
            response = await client.post(
                f"{settings.minimax_base_url}/v1/t2a_v2",
                params=({"GroupId": group_id} if group_id else None),
                json=payload,
                headers={
                    "Authorization": f"Bearer {settings.minimax_api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
        if response.status_code >= 400:
            raise ProviderError(f"MiniMax 语音请求失败：{_json_error(response)}")
        data = response.json()
        base_resp = data.get("base_resp") or {}
        if base_resp.get("status_code", 0) != 0:
            raise ProviderError(f"MiniMax 语音生成失败：{base_resp.get('status_msg') or '未知错误'}")
        payload_data = data.get("data") if isinstance(data.get("data"), dict) else {}
        audio = payload_data.get("audio") or data.get("audio") or ""
        if not audio:
            raise ProviderError("MiniMax 语音接口未返回音频")
        try:
            raw = bytes.fromhex(audio)
        except ValueError:
            try:
                raw = base64.b64decode(audio)
            except Exception as exc:
                raise ProviderError("MiniMax 返回的音频无法解码") from exc
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(raw)
        return {
            "path": str(output_path),
            "durationMs": int((data.get("extra_info") or {}).get("audio_length") or 0),
            "voiceId": selected_voice_id,
            "model": settings.minimax_tts_model,
            "speed": speed,
            "targetDurationMs": (
                int(round(float(target_duration_sec) * 1000))
                if target_duration_sec
                else 0
            ),
        }


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _find_task_id(data: dict[str, Any]) -> str:
    for obj in _walk(data):
        for key in ("id", "task_id", "taskId", "generation_id", "generationId"):
            value = obj.get(key)
            if value and not isinstance(value, (dict, list)):
                return str(value)
    return ""


def _find_status(data: dict[str, Any]) -> str:
    values = []
    for obj in _walk(data):
        for key in ("status", "state", "task_status"):
            value = obj.get(key)
            if isinstance(value, str):
                values.append(value.lower())
    joined = " ".join(values)
    if any(word in joined for word in ("failed", "error", "cancelled", "canceled")):
        return "failed"
    if any(word in joined for word in ("succeeded", "success", "completed", "done")):
        return "succeeded"
    return "running"


def _find_video_url(data: dict[str, Any]) -> str:
    candidates: list[tuple[int, str]] = []
    for obj in _walk(data):
        for key, value in obj.items():
            if not isinstance(value, str) or not value.startswith(("http://", "https://")):
                continue
            low_key = key.lower()
            low_value = value.lower()
            score = 0
            if "video" in low_key:
                score += 4
            if low_value.split("?", 1)[0].endswith((".mp4", ".mov", ".webm")):
                score += 3
            if "cover" in low_key or "poster" in low_key or "image" in low_key:
                score -= 5
            candidates.append((score, value))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1] if candidates and candidates[0][0] > 0 else ""


def _seedance_prompt(prompt: str) -> str:
    """Apply render-only negatives without constraining the director plan."""
    source = _sanitize_seedance_visual_text(prompt)
    if _SEEDANCE_TEXT_NEGATIVE in source:
        return source
    return f"{source}\n{_SEEDANCE_TEXT_NEGATIVE}".strip()


class SeedanceVideo:
    @property
    def submit_url(self) -> str:
        return f"{settings.seedance_base_url}/api/v3/contents/generations/tasks"

    def poll_url(self, task_id: str) -> str:
        return f"{self.submit_url}/{task_id}"

    @staticmethod
    def build_payload(
        prompt: str,
        aspect_ratio: str,
        reference_images: list[str] | None = None,
        duration_sec: int = 8,
    ) -> dict[str, Any]:
        content: list[dict[str, Any]] = [{"type": "text", "text": _seedance_prompt(prompt)}]
        content.extend(
            {
                "type": "image_url",
                "image_url": {"url": image_url},
                "role": "reference_image",
            }
            for image_url in (reference_images or [])[:3]
        )
        return {
            "model": settings.seedance_model,
            "content": content,
            "ratio": aspect_ratio,
            "duration": max(4, min(15, _safe_int(duration_sec, 8))),
            "resolution": settings.seedance_resolution,
            "watermark": False,
            "generate_audio": False,
            "return_last_frame": True,
        }

    async def generate(
        self,
        prompt: str,
        aspect_ratio: str,
        output_path: Path,
        callback: ProgressCallback | None = None,
        scene_number: int = 1,
        reference_images: list[str] | None = None,
        duration_sec: int = 8,
    ) -> dict[str, Any]:
        if not settings.seedance_api_key:
            raise ProviderError("Seedance API Key 未配置")
        clip_duration = max(4, min(15, _safe_int(duration_sec, 8)))
        payload = self.build_payload(prompt, aspect_ratio, reference_images, clip_duration)
        headers = {
            "Authorization": f"Bearer {settings.seedance_api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        async with _client(180) as client:
            response = await client.post(self.submit_url, json=payload, headers=headers)
        if response.status_code >= 400:
            raise ProviderError(f"Seedance 第 {scene_number} 段提交失败：{_json_error(response)}")
        data = response.json()
        task_id = _find_task_id(data)
        if not task_id:
            raise ProviderError(f"Seedance 第 {scene_number} 段未返回任务 ID")
        if callback:
            await callback(
                f"镜头 {scene_number} 已进入 Seedance 队列",
                f"{clip_duration} 秒 {settings.seedance_resolution} 片段正在生成",
                min(56, 24 + scene_number * 3),
            )

        video_url = _find_video_url(data)
        status = _find_status(data)
        attempts = 0
        transient_failures = 0
        while not video_url and status != "failed" and attempts < 180:
            await asyncio.sleep(10 if attempts else 4)
            attempts += 1
            try:
                async with _client(90) as client:
                    response = await client.get(self.poll_url(task_id), headers=headers)
            except httpx.RequestError as exc:
                transient_failures += 1
                if transient_failures > 8:
                    raise ProviderError(
                        f"Seedance 第 {scene_number} 段连续查询失败：{exc.__class__.__name__}"
                    ) from exc
                if callback:
                    await callback(
                        f"镜头 {scene_number} 查询短暂断开，正在自动重连",
                        f"已保留 Seedance 任务，第 {transient_failures} 次重连不会重复提交生成。",
                        min(58, 30 + attempts // 3),
                    )
                await asyncio.sleep(min(24, transient_failures * 3))
                continue
            if response.status_code >= 400:
                if response.status_code in {408, 425, 429, 500, 502, 503, 504}:
                    transient_failures += 1
                    if transient_failures <= 8:
                        if callback:
                            await callback(
                                f"镜头 {scene_number} 查询服务繁忙，正在自动重试",
                                f"Seedance 返回 HTTP {response.status_code}，任务不会重复提交。",
                                min(58, 30 + attempts // 3),
                            )
                        await asyncio.sleep(min(24, transient_failures * 3))
                        continue
                if response.status_code in {429, 500, 502, 503, 504} and attempts < 6:
                    continue
                raise ProviderError(f"Seedance 第 {scene_number} 段查询失败：{_json_error(response)}")
            transient_failures = 0
            data = response.json()
            status = _find_status(data)
            video_url = _find_video_url(data)
            if callback and attempts % 3 == 0:
                await callback(
                    f"Seedance 正在生成镜头 {scene_number}",
                    f"已等待约 {attempts * 10} 秒，任务状态正常",
                    min(58, 30 + attempts // 3),
                )
        if status == "failed":
            raise ProviderError(f"Seedance 第 {scene_number} 段生成失败：{_json_error(response)}")
        if not video_url:
            raise ProviderError(f"Seedance 第 {scene_number} 段生成超时")

        await _download_seedance_video(
            video_url,
            output_path,
            callback=callback,
            scene_number=scene_number,
        )
        return {"path": str(output_path), "taskId": task_id, "model": settings.seedance_model}


director = MiniMaxDirector()
tts = MiniMaxTTS()
seedance = SeedanceVideo()
