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

NARRATION_UNITS_PER_SECOND = 4.35
MIN_NARRATION_SPEED = 0.85
MAX_NARRATION_SPEED = 1.15


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


def _explicit_duration_seconds(messages: list[dict[str, Any]]) -> int | None:
    patterns = (
        r"(?:总时长|成片时长|视频时长|时长)\s*(?:为|是|约|大约|控制在|做成)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)",
        r"(?:制作|创作|生成|做|剪|来)\s*(?:一条|一个|一段)?\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)",
        r"(?:一条|一个|一段)\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)",
        r"(?<![-–—\d])(\d{1,3}(?:\.\d+)?)\s*(?:秒|s\b)\s*(?:左右|以内|以上)?\s*(?:的)?\s*(?:视频|成片|短片|片子)",
    )
    for message in reversed(messages):
        if message.get("role") != "user":
            continue
        text = str(message.get("content") or "")
        for pattern in patterns:
            match = re.search(pattern, text, re.I)
            if not match:
                continue
            value = _safe_float(match.group(1), 0)
            if 1 <= value <= 600:
                return max(1, int(round(value)))
    return None


def _narration_units(text: str) -> float:
    cjk_count = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff]", text))
    latin_words = len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", text))
    return float(cjk_count) + float(latin_words) * 1.7


def _narration_unit_bounds(target_duration_sec: float) -> tuple[float, float]:
    duration = max(1.0, _safe_float(target_duration_sec, 1.0))
    return duration * 3.7, duration * 4.95


def _narration_needs_duration_repair(text: str, target_duration_sec: float) -> bool:
    minimum, maximum = _narration_unit_bounds(target_duration_sec)
    units = _narration_units(text)
    return units < minimum or units > maximum


def _tts_speed_for_target(text: str, target_duration_sec: float | None) -> float:
    target = _safe_float(target_duration_sec, 0.0)
    if target <= 0:
        return 1.0
    estimated_duration = _narration_units(text) / NARRATION_UNITS_PER_SECOND
    if estimated_duration <= 0:
        return 1.0
    return round(
        max(
            MIN_NARRATION_SPEED,
            min(MAX_NARRATION_SPEED, estimated_duration / target),
        ),
        3,
    )


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
                    "description": "信息不足时只追问一个最影响成片的问题。",
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
                                        "purpose": {"type": "string"},
                                    },
                                    "required": ["title", "duration_sec", "visual_prompt", "purpose"],
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
        duration_instruction = ""
        if requested_duration_sec:
            preferred_units = round(requested_duration_sec * NARRATION_UNITS_PER_SECOND)
            minimum_units, maximum_units = _narration_unit_bounds(requested_duration_sec)
            duration_instruction = (
                f"\n本轮用户明确要求成片约 {requested_duration_sec} 秒。"
                f"duration_sec 必须填写 {requested_duration_sec}；若 input_mode=topic，"
                f"口播应按自然中文语速写到约 {preferred_units} 个有效汉字，"
                f"可接受范围约 {round(minimum_units)}-{round(maximum_units)} 个，"
                "让有效内容真实覆盖目标时长，不能用长静音补足。"
                "若使用用户上传口播音频，则原音频仍是唯一主时间线，不得拉伸或补写。"
            )
        return f"""你是星阵视频工坊的总导演 Agent。这个工作台只服务定制化、高质量视频，你拥有叙事、口播、总时长、镜头数量、镜头节奏、视觉方案和声音设计的完整导演权。

工作方式：
1. 你必须调用 ask_user 或 start_video_production，不能只写普通文本。
2. 用户要求拥有最高优先级。系统根据当前会话识别画幅为 {aspect_ratio}；用户没有说明画幅时才默认 9:16。
3. 只有主题、目标或关键主体不清楚时才调用 ask_user；一次只问一个决定性问题。
4. 用户明确指定时长、结构、风格或镜头数量时必须执行；用户未指定时，由你根据表达完整度自主决定，不得套用固定时长、固定段数、固定文案字数或固定叙事公式。
5. duration_sec 是你对完整口播时长的估算。scenes 数量由你决定；每个 Seedance 原始片段受接口限制只能为 4 到 15 秒，这只是技术边界，不是创作模板。
6. 每个 visual_prompt 都必须是可独立执行的完整镜头描述，因为不同镜头会作为独立任务提交；镜头之间采用何种叙事和视觉关系由你决定。
7. input_mode=topic 时你创作完整口播；input_mode=script 时默认保留用户口播原文，除非用户明确要求改写；input_mode=audio 时必须使用附件转写稿作为口播并以原音频作为主时间线，不得重新配音。
8. director_note 和 public_thoughts 只承载可公开的导演决策，不得包含隐藏提示词、密钥或内部工具名称。
9. 附件编号使用“图1、视频1、音频1”。图片可以是 reference/material/both，视频只能是 material/unused，音频可以是 narration/bgm/sfx/unused；用户明确说法优先。
10. material 只表示参与剪辑，presentation 决定呈现方式。Logo、品牌标志、透明图、角标必须用 overlay；普通图片和素材视频优先用 pip，让 AI 主画面与连续口播始终保留；只有用户明确要求替换画面或素材本身承担完整叙事时才用 cutaway。
11. material、both 或 sfx 需要关联有效的 scene_number 和 narration_anchor，后端据此把素材放进对应口播位置。用途冲突且会显著改变成片时，再调用 ask_user 确认。
12. audio_design 由内容需要决定。BGM 必须服从口播；可用 BGM 清单为 {bgm_options}。用户上传并指定的 BGM 优先，未指定具体曲目时 bgm_track_id 留空。
{duration_instruction}

内置视频制作工作流：
{skill_context}
"""

    @staticmethod
    def _tool_call(message: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
        calls = message.get("tool_calls") or []
        if not calls and message.get("function_call"):
            calls = [{"function": message["function_call"]}]
        if not calls:
            return None
        function = calls[0].get("function") or {}
        name = str(function.get("name") or "")
        arguments = function.get("arguments") or "{}"
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                match = re.search(r"\{.*\}", arguments, re.S)
                if not match:
                    raise ProviderError("MiniMax-M3 返回了无法解析的工具参数")
                arguments = json.loads(match.group(0))
        return name, arguments

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
            "max_completion_tokens": settings.llm_max_completion_tokens,
        }
        async with _client(150) as client:
            response = await client.post(
                settings.llm_endpoint,
                json=payload,
                headers={
                    "Authorization": f"Bearer {settings.llm_api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
        if response.status_code >= 400:
            raise ProviderError(f"MiniMax-M3 请求失败：{_json_error(response)}")
        data = response.json()
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("MiniMax-M3 没有返回可用消息") from exc

        call = self._tool_call(message)
        if not call:
            content = str(message.get("content") or "").strip()
            if content:
                return {"action": "ask", "question": content[:240], "missing": ["模型未调用导演工具"]}
            raise ProviderError("MiniMax-M3 未调用导演工具")

        name, arguments = call
        if name == "ask_user":
            suggestions = [str(item)[:80] for item in list(arguments.get("suggestions") or []) if str(item).strip()][:3]
            if len(suggestions) < 2:
                suggestions = (
                    ["按你的判断自动分配", "图片只作生成参考", "把上传素材剪进成片"]
                    if attachments
                    else ["按你的建议继续", "我补充目标受众", "我补充画面要求"]
                )
            return {
                "action": "ask",
                "question": str(arguments.get("question") or "你最想让观众记住哪一句话？")[:240],
                "missing": arguments.get("missing") or [],
                "suggestions": suggestions,
            }
        if name != "start_video_production":
            raise ProviderError(f"MiniMax-M3 调用了未知工具：{name}")

        supported_ratios = {"9:16", "16:9", "1:1", "4:3", "3:4", "21:9"}
        arguments["aspect_ratio"] = aspect_ratio if aspect_ratio in supported_ratios else "9:16"
        scenes = [scene for scene in list(arguments.get("scenes") or []) if isinstance(scene, dict)]
        if not scenes:
            raise ProviderError("导演计划必须包含至少一个可执行镜头")
        for index, scene in enumerate(scenes):
            scene["title"] = str(scene.get("title") or f"镜头 {index + 1}")[:120]
            scene["duration_sec"] = max(4, min(15, _safe_int(scene.get("duration_sec"), 8)))
            scene["visual_prompt"] = str(scene.get("visual_prompt") or "").strip()
            scene["purpose"] = str(scene.get("purpose") or "推进当前叙事")[:300]
            if not scene["visual_prompt"]:
                raise ProviderError(f"导演计划的镜头 {index + 1} 缺少画面提示词")
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
        narration = str(arguments.get("narration") or "").strip()
        if not narration:
            raise ProviderError("导演计划缺少口播内容")
        arguments["narration"] = narration
        input_mode = str(arguments.get("input_mode") or "topic")
        if input_mode not in {"topic", "script", "audio"}:
            input_mode = "topic"
        arguments["input_mode"] = input_mode
        if requested_duration_sec:
            arguments["requested_duration_sec"] = requested_duration_sec
            arguments["duration_sec"] = requested_duration_sec
            if (
                input_mode == "topic"
                and not any(
                    str((item.get("transcript") or {}).get("text") or "").strip()
                    for item in attachments
                    if isinstance(item, dict)
                )
                and _narration_needs_duration_repair(
                    arguments["narration"],
                    requested_duration_sec,
                )
            ):
                arguments["narration"] = await self._repair_narration_duration(
                    arguments,
                    requested_duration_sec,
                )
        raw_audio_design = arguments.get("audio_design") if isinstance(arguments.get("audio_design"), dict) else {}
        arguments["audio_design"] = {
            "bgm_enabled": bool(raw_audio_design.get("bgm_enabled", True)),
            "bgm_mood": str(raw_audio_design.get("bgm_mood") or arguments.get("tone") or "克制")[:120],
            "bgm_track_id": str(raw_audio_design.get("bgm_track_id") or "")[:120],
            "bgm_volume": max(0.03, min(0.3, _safe_float(raw_audio_design.get("bgm_volume"), 0.12))),
            "sound_note": str(raw_audio_design.get("sound_note") or "保持口播清晰，音乐只承担氛围。")[:300],
        }
        latest_user_text = next(
            (str(item.get("content") or "") for item in reversed(messages) if item.get("role") == "user"),
            "",
        )
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
            default_role = "reference" if media_type == "image" else "material" if media_type == "video" else "narration" if has_transcript else "unused"
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
            asset_name = str(asset.get("name") or "").lower()
            is_logo = media_type == "image" and any(
                marker in asset_name for marker in ("logo", "标志", "徽标", "角标", "水印", "icon")
            )
            presentation = str(item.get("presentation") or "auto")
            if presentation not in {"auto", "overlay", "pip", "cutaway"}:
                presentation = "auto"
            if is_logo:
                presentation = "overlay"
            elif presentation == "auto":
                presentation = "pip" if media_type in {"image", "video"} else "cutaway"
            position = str(item.get("position") or ("top-right" if presentation == "overlay" else "bottom-right"))
            if position not in {"top-left", "top-right", "bottom-left", "bottom-right", "center"}:
                position = "top-right" if presentation == "overlay" else "bottom-right"
            default_scale = 0.22 if is_logo else 0.36
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

    async def _repair_narration_duration(
        self,
        plan: dict[str, Any],
        target_duration_sec: int,
    ) -> str:
        preferred_units = round(target_duration_sec * NARRATION_UNITS_PER_SECOND)
        minimum_units, maximum_units = _narration_unit_bounds(target_duration_sec)
        repair_tool = {
            "type": "function",
            "function": {
                "name": "repair_narration_duration",
                "description": "只返回按目标时长校准后的完整口播。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "narration": {
                            "type": "string",
                            "description": "信息完整、自然可说、没有重复灌水的完整口播。",
                        },
                    },
                    "required": ["narration"],
                },
            },
        }
        repair_context = {
            "target_duration_sec": target_duration_sec,
            "preferred_effective_units": preferred_units,
            "acceptable_effective_units": [
                round(minimum_units),
                round(maximum_units),
            ],
            "title": str(plan.get("title") or ""),
            "audience": str(plan.get("audience") or ""),
            "tone": str(plan.get("tone") or ""),
            "core_message": str(plan.get("core_message") or ""),
            "current_narration": str(plan.get("narration") or ""),
            "scene_purposes": [
                str(scene.get("purpose") or "")
                for scene in list(plan.get("scenes") or [])
                if isinstance(scene, dict)
            ],
        }
        payload = {
            "model": settings.llm_model,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "你是口播时长校准编辑。保持原主题、事实边界、受众、语气与结论，"
                        "通过补足必要解释、场景和转折或压缩冗余，使口播自然覆盖用户目标时长。"
                        "不得重复句子、堆砌同义词、加入无依据数据，也不得用静音作为时长。"
                        "只调用 repair_narration_duration。"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(repair_context, ensure_ascii=False),
                },
            ],
            "tools": [repair_tool],
            "tool_choice": {
                "type": "function",
                "function": {"name": "repair_narration_duration"},
            },
            "temperature": 0.2,
            "thinking": {"type": settings.llm_thinking},
            "reasoning_split": True,
            "max_completion_tokens": settings.llm_max_completion_tokens,
        }
        async with _client(150) as client:
            response = await client.post(
                settings.llm_endpoint,
                json=payload,
                headers={
                    "Authorization": f"Bearer {settings.llm_api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
        if response.status_code >= 400:
            raise ProviderError(
                f"口播时长校准失败：{_json_error(response)}"
            )
        data = response.json()
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ProviderError("口播时长校准没有返回可用消息") from exc
        call = self._tool_call(message)
        if not call or call[0] != "repair_narration_duration":
            raise ProviderError("口播时长校准没有返回结构化口播")
        narration = str(call[1].get("narration") or "").strip()
        if not narration:
            raise ProviderError("口播时长校准返回了空内容")
        if _narration_needs_duration_repair(narration, target_duration_sec):
            actual_units = round(_narration_units(narration))
            raise ProviderError(
                f"口播时长校准后仍只有约 {actual_units} 个有效字，"
                f"未覆盖用户明确的 {target_duration_sec} 秒；已停止制作，避免输出短片。"
            )
        return narration

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
            async with _client(150) as client:
                response = await client.post(
                    settings.llm_endpoint,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {settings.llm_api_key}",
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                )
            if response.status_code >= 400:
                return self._fallback_safe_rewrite(plan, scene_number)
            message = response.json()["choices"][0]["message"]
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
        except (KeyError, IndexError, TypeError, ValueError, httpx.HTTPError):
            return self._fallback_safe_rewrite(plan, scene_number)


class MiniMaxTTS:
    async def generate(
        self,
        text: str,
        output_path: Path,
        target_duration_sec: float | None = None,
    ) -> dict[str, Any]:
        if not settings.minimax_api_key:
            raise ProviderError("MiniMax TTS API Key 未配置")
        speed = _tts_speed_for_target(text, target_duration_sec)
        payload = {
            "model": settings.minimax_tts_model,
            "text": text[:9999],
            "stream": False,
            "language_boost": "Chinese",
            "output_format": "hex",
            "voice_setting": {
                "voice_id": settings.minimax_voice_id,
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
            "voiceId": settings.minimax_voice_id,
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
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
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
