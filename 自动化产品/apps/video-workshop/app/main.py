from __future__ import annotations

import asyncio
import base64
import math
import mimetypes
import re
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .bgm import bgm_library
from .config import settings
from .media import MediaError, extract_video_preview, probe
from .openmontage_bridge import openmontage
from .pipeline import pipeline
from .providers import ProviderError, director, seedance, tts
from .store import add_event, add_message, create_project, list_project_summaries, load_project, mutate_project
from .transcription import TranscriptionError, transcriber
from .video_skill import SKILL_NAME, director_context, strip_command


app = FastAPI(title="星阵视频导演台", version="0.1.0")
app.mount("/assets", StaticFiles(directory=settings.web_dir / "assets"), name="assets")
app.mount("/outputs", StaticFiles(directory=settings.outputs_dir), name="outputs")
app.mount("/uploads", StaticFiles(directory=settings.uploads_dir), name="uploads")

_tasks: set[asyncio.Task[Any]] = set()
_project_tasks: dict[str, asyncio.Task[Any]] = {}
_launching_projects: set[str] = set()


def _project_has_active_work(project_id: str) -> bool:
    task = _project_tasks.get(project_id)
    if task is not None:
        if not task.done():
            return True
        if _project_tasks.get(project_id) is task:
            _project_tasks.pop(project_id, None)
        _tasks.discard(task)
    return project_id in _launching_projects


@contextmanager
def _launching_project(project_id: str):
    _launching_projects.add(project_id)
    try:
        yield
    finally:
        _launching_projects.discard(project_id)


def _policy_failure_reason(value: Any) -> str:
    text = str(value or "").lower()
    if any(marker in text for marker in ("copyright restriction", "related to copyright", "copyright policy")):
        return "copyright"
    if any(marker in text for marker in ("sensitive information", "content safety", "safety policy", "risk control")):
        return "safety"
    return ""


class Attachment(BaseModel):
    label: str = ""
    name: str = "attachment"
    mime: str = "image/png"
    dataUrl: str


class ChatRequest(BaseModel):
    projectId: str = ""
    message: str = Field(min_length=1, max_length=8000)
    aspectRatio: str = "9:16"
    voiceId: str = Field(default="", max_length=180)
    attachments: list[Attachment] = Field(default_factory=list)


class RenameProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class VoiceTestRequest(BaseModel):
    voiceId: str = Field(default="", max_length=180)


def _schedule(
    project_id: str,
    plan: dict[str, Any],
    retry_scene_number: int | None = None,
) -> None:
    current = _project_tasks.get(project_id)
    if current is not None and not current.done():
        return
    task = asyncio.create_task(
        pipeline.run(project_id, plan, retry_scene_number=retry_scene_number)
    )
    _tasks.add(task)
    _project_tasks[project_id] = task

    def clear(completed: asyncio.Task[Any]) -> None:
        _tasks.discard(completed)
        if _project_tasks.get(project_id) is completed:
            _project_tasks.pop(project_id, None)

    task.add_done_callback(clear)


def _retry_info(project: dict[str, Any]) -> dict[str, Any] | None:
    scenes = list((project.get("plan") or {}).get("scenes") or [])
    scene_count = len(scenes)
    retryable = project.get("retryable")
    if isinstance(retryable, dict) and retryable.get("type") in {"safe_rewrite", "resume_missing"}:
        scene_number = int(retryable.get("sceneNumber") or 0)
        if 1 <= scene_number <= scene_count:
            result = {"type": retryable["type"], "sceneNumber": scene_number}
            reason = str(retryable.get("reason") or "")
            if reason:
                result["reason"] = reason
            return result
    error = str(project.get("error") or "")
    match = re.search(r"第\s*(\d+)\s*段", error)
    reason = _policy_failure_reason(error)
    if match and reason:
        return {"type": "safe_rewrite", "sceneNumber": int(match.group(1)), "reason": reason}
    project_id = str(project.get("id") or "")
    work_dir = settings.outputs_dir / project_id
    narration_exists = (work_dir / "narration.mp3").is_file()
    missing_scenes = [
        scene_number
        for scene_number in range(1, scene_count + 1)
        if not (work_dir / f"scene-{scene_number:02d}.mp4").is_file()
    ]
    if project_id and narration_exists and missing_scenes:
        return {"type": "resume_missing", "sceneNumber": missing_scenes[0]}
    return None


def _mark_orphaned_running_project(project_id: str) -> dict[str, Any]:
    def recover(project: dict[str, Any]) -> None:
        if project.get("status") != "running":
            return
        retryable = _retry_info(project)
        resumable = bool(retryable and retryable.get("type") == "resume_missing")
        scene_number = int((retryable or {}).get("sceneNumber") or 0)
        if resumable:
            public_error = (
                "服务重启，已保留素材，可继续缺失镜头；"
                f"将从缺失镜头 {scene_number} 开始继续所有未完成镜头。"
            )
            event_title = "服务重启，已保留素材，可继续缺失镜头"
            project["retryable"] = retryable
        else:
            public_error = (
                "服务重启，当前制作任务已中断；未发现可安全续作的完整素材，"
                "请重新发起制作。"
            )
            event_title = "服务重启，制作任务已中断"
            project["retryable"] = None

        project["status"] = "failed"
        project["phase"] = "error"
        project["error"] = public_error
        at = project.get("updatedAt") or project.get("createdAt") or ""
        events = project.setdefault("events", [])
        if not any(
            event.get("recoveryType") == "service-restart"
            for event in events
        ):
            events.append(
                {
                    "id": f"{project_id}-service-restart-event",
                    "title": event_title,
                    "detail": public_error,
                    "status": "error",
                    "phase": "error",
                    "at": at,
                    "recoveryType": "service-restart",
                }
            )
            project["events"] = events[-80:]
        messages = project.setdefault("messages", [])
        if not any(
            message.get("recoveryType") == "service-restart"
            for message in messages
        ):
            messages.append(
                {
                    "id": f"{project_id}-service-restart-message",
                    "role": "assistant",
                    "content": public_error,
                    "kind": "error",
                    "at": at,
                    "recoveryType": "service-restart",
                }
            )

    return mutate_project(project_id, recover)


def _project_response(project: dict[str, Any]) -> dict[str, Any]:
    if project.get("status") == "failed":
        retryable = _retry_info(project)
        project["retryable"] = retryable
        if retryable and retryable.get("type") == "safe_rewrite":
            scene_number = int(retryable["sceneNumber"])
            is_copyright = retryable.get("reason") == "copyright"
            public_error = (
                f"镜头 {scene_number} 未通过版权风险审核，可以改写为原创中性视觉后只重试这个镜头。"
                if is_copyright
                else f"镜头 {scene_number} 未通过内容安全审核，可以安全改写后只重试这个镜头。"
            )
            project["phase"] = "error"
            project["error"] = public_error
            for event in project.get("events") or []:
                if _policy_failure_reason(event.get("detail")):
                    event["detail"] = public_error
            for message in project.get("messages") or []:
                if _policy_failure_reason(message.get("content")):
                    message["content"] = f"制作在当前步骤停住了：{public_error}"
            events = project.get("events") or []
            if not events or events[-1].get("status") != "error":
                events.append(
                    {
                        "id": f"{project.get('id')}-recovery",
                        "title": "等待原创改写" if is_copyright else "等待安全改写",
                        "detail": public_error,
                        "status": "error",
                        "at": project.get("updatedAt") or "",
                    }
                )
                project["events"] = events
        elif retryable and retryable.get("type") == "resume_missing":
            scene_number = int(retryable["sceneNumber"])
            restart_recovery = any(
                message.get("recoveryType") == "service-restart"
                for message in project.get("messages") or []
            )
            public_error = (
                "服务重启，已保留素材，可继续缺失镜头；"
                f"将从缺失镜头 {scene_number} 开始继续所有未完成镜头。"
                if restart_recovery
                else (
                    f"镜头 {scene_number} 的生成连接中断，但口播和其他镜头已经保留，"
                    f"可以从缺失镜头 {scene_number} 开始继续所有未完成镜头。"
                )
            )
            project["phase"] = "error"
            project["error"] = public_error
            messages = project.get("messages") or []
            if messages and messages[-1].get("kind") == "error":
                messages[-1]["content"] = (
                    public_error
                    if messages[-1].get("recoveryType") == "service-restart"
                    else f"制作在当前步骤停住了：{public_error}"
                )
            events = project.get("events") or []
            if events and events[-1].get("status") == "error":
                events[-1]["detail"] = public_error
    if project.get("status") == "succeeded":
        for message in project.get("messages") or []:
            if message.get("kind") != "error":
                continue
            content = str(message.get("content") or "")
            scene_match = re.search(r"第\s*(\d+)\s*段|镜头\s*(\d+)", content)
            scene_number = next((item for item in (scene_match.groups() if scene_match else ()) if item), "")
            scene_label = f"镜头 {scene_number}" if scene_number else "某个镜头"
            reason = _policy_failure_reason(content)
            if reason == "copyright":
                content = f"{scene_label}曾触发版权风险审核，已通过原创改写完成制作。"
            elif reason == "safety":
                content = f"{scene_label}曾触发内容安全审核，已通过安全改写完成制作。"
            elif "connecttimeout" in content.lower() or "连接" in content:
                content = "生成连接曾短暂中断，系统保留了完成素材并从缺失镜头继续制作。"
            else:
                content = re.sub(r"^制作在当前步骤停住了[：:]\s*", "", content)
            message["kind"] = "resolved"
            message["content"] = f"已恢复：{content}"
        for event in project.get("events") or []:
            if event.get("status") != "error":
                continue
            detail = str(event.get("detail") or "")
            if "connecttimeout" in detail.lower() or "连接" in detail:
                detail = "生成连接曾短暂中断，已从本地保留进度恢复完成。"
            elif _policy_failure_reason(detail):
                detail = "镜头审核曾中断制作，已通过改写恢复完成。"
            event["title"] = f"已恢复 · {event.get('title') or '制作中断'}"
            event["detail"] = detail
            event["status"] = "done"
    return project


_ALLOWED_ATTACHMENT_MIMES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/x-wav",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
}


def _decode_attachments(attachments: list[Attachment]) -> list[tuple[Attachment, str, bytes]]:
    decoded: list[tuple[Attachment, str, bytes]] = []
    total_bytes = 0
    for item in attachments[:8]:
        match = re.match(r"^data:((?:image|video|audio)/[a-zA-Z0-9.+-]+);base64,(.+)$", item.dataUrl, re.S)
        if not match:
            continue
        try:
            raw = base64.b64decode(match.group(2), validate=True)
        except Exception:
            continue
        mime = match.group(1).lower()
        if mime not in _ALLOWED_ATTACHMENT_MIMES:
            raise HTTPException(415, f"暂不支持 {mime} 格式")
        per_file_limit = 6 * 1024 * 1024 if mime.startswith("image/") else 40 * 1024 * 1024
        if len(raw) > per_file_limit:
            limit_label = "6MB" if mime.startswith("image/") else "40MB"
            raise HTTPException(413, f"附件“{item.name[:80]}”不能超过 {limit_label}")
        total_bytes += len(raw)
        if total_bytes > 80 * 1024 * 1024:
            raise HTTPException(413, "本次附件总大小不能超过 80MB")
        decoded.append((item, mime, raw))
    return decoded


def _save_attachments(
    project_id: str,
    decoded: list[tuple[Attachment, str, bytes]],
    existing_assets: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    saved: list[dict[str, Any]] = []
    target_dir = settings.uploads_dir / project_id
    target_dir.mkdir(parents=True, exist_ok=True)
    image_count = sum(1 for item in existing_assets if str(item.get("mime") or "").startswith("image/"))
    video_count = sum(1 for item in existing_assets if str(item.get("mime") or "").startswith("video/"))
    audio_count = sum(1 for item in existing_assets if str(item.get("mime") or "").startswith("audio/"))
    extensions = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
        "audio/mpeg": ".mp3",
        "audio/mp3": ".mp3",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
        "audio/mp4": ".m4a",
        "audio/x-m4a": ".m4a",
        "audio/m4a": ".m4a",
    }
    for item, mime, raw in decoded:
        extension = extensions.get(mime) or mimetypes.guess_extension(mime) or ".bin"
        filename = f"{uuid.uuid4().hex[:10]}{extension}"
        path = target_dir / filename
        path.write_bytes(raw)
        if mime.startswith("image/"):
            image_count += 1
            label = f"图{image_count}"
            media_type = "image"
        elif mime.startswith("video/"):
            video_count += 1
            label = f"视频{video_count}"
            media_type = "video"
        else:
            audio_count += 1
            label = f"音频{audio_count}"
            media_type = "audio"
        saved.append(
            {
                "asset_id": uuid.uuid4().hex[:12],
                "label": label,
                "media_type": media_type,
                "name": item.name[:180],
                "mime": mime,
                "url": f"/uploads/{project_id}/{filename}",
                "size": len(raw),
            }
        )
    return saved


async def _enrich_saved_attachments(project_id: str, assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    target_dir = settings.uploads_dir / project_id
    for item in assets:
        mime = str(item.get("mime") or "")
        if mime.startswith("image/"):
            item["previewUrl"] = item["url"]
            continue
        source = target_dir / Path(str(item["url"])).name
        if mime.startswith("audio/"):
            try:
                info = await probe(source)
            except MediaError as exc:
                source.unlink(missing_ok=True)
                raise HTTPException(422, f"音频“{item['name']}”无法读取：{exc}") from exc
            item.update(
                {
                    "previewUrl": item["url"],
                    "duration": info.get("duration"),
                    "audioCodec": info.get("audioCodec"),
                }
            )
            continue
        preview = target_dir / f"{source.stem}-preview.jpg"
        try:
            info = await extract_video_preview(source, preview)
        except MediaError as exc:
            source.unlink(missing_ok=True)
            raise HTTPException(422, f"视频“{item['name']}”无法读取：{exc}") from exc
        item.update(
            {
                "previewUrl": f"/uploads/{project_id}/{preview.name}",
                "duration": info.get("duration"),
                "width": info.get("width"),
                "height": info.get("height"),
            }
        )
    return assets


def _hydrate_assets_for_director(project_id: str, assets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    hydrated: list[dict[str, Any]] = []
    root = settings.uploads_dir / project_id
    for item in assets[:8]:
        copy = dict(item)
        if str(item.get("mime") or "").startswith("image/"):
            media_path = root / Path(str(item.get("url") or "")).name
            if media_path.is_file() and media_path.stat().st_size <= 6 * 1024 * 1024:
                encoded = base64.b64encode(media_path.read_bytes()).decode("ascii")
                copy["visionDataUrl"] = f"data:{item['mime']};base64,{encoded}"
        elif str(item.get("mime") or "").startswith("video/"):
            preview_path = root / Path(str(item.get("previewUrl") or "")).name
            if preview_path.is_file():
                encoded = base64.b64encode(preview_path.read_bytes()).decode("ascii")
                copy["visionDataUrl"] = f"data:image/jpeg;base64,{encoded}"
        hydrated.append(copy)
    return hydrated


def _infer_aspect_ratio(message: str) -> str:
    text = re.sub(r"\s+", "", message).lower()
    explicit_patterns = (
        ("21:9", ("21:9", "21：9", "超宽屏", "电影宽幅")),
        ("16:9", ("16:9", "16：9", "横屏", "横版", "横向", "宽屏")),
        ("4:3", ("4:3", "4：3")),
        ("3:4", ("3:4", "3：4")),
        ("1:1", ("1:1", "1：1", "方形", "正方形")),
        ("9:16", ("9:16", "9：16", "竖屏", "竖版", "纵向")),
    )
    matches: list[tuple[int, str]] = []
    for ratio, markers in explicit_patterns:
        for marker in markers:
            position = text.rfind(marker)
            if position >= 0:
                matches.append((position, ratio))
    return max(matches, default=(-1, "9:16"))[1]


_VOICE_ID_SAFE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:@+()\- ]{0,179}$")
_VOICE_ID_DIRECTIVE_RE = re.compile(
    r"(?:音色\s*(?:ID|id)|voice[\s_-]*id\b)\s*(?:[:：=]|为|是)?\s*"
    r"(?:[\"“'](?P<quoted>[^\"”'\r\n]{1,180})[\"”']|"
    r"(?P<bare>[A-Za-z0-9][A-Za-z0-9_.:@+()\-]{0,179}))",
    re.I,
)


def _normalize_voice_id(value: Any) -> str:
    voice_id = str(value or "").strip()
    if not voice_id:
        return ""
    if not _VOICE_ID_SAFE_RE.fullmatch(voice_id):
        raise ValueError("音色 ID 包含不支持的字符")
    return voice_id


def _explicit_voice_id(message: str) -> str:
    match = _VOICE_ID_DIRECTIVE_RE.search(str(message or ""))
    if not match:
        return ""
    return _normalize_voice_id(match.group("quoted") or match.group("bare") or "")


def _message_without_voice_id_directive(message: str) -> str:
    cleaned = _VOICE_ID_DIRECTIVE_RE.sub("", str(message or ""))
    cleaned = cleaned.strip(" \t\r\n,，;；。")
    return cleaned or "请使用已指定音色按当前上下文继续制作"


def _director_messages_without_voice_id_directives(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    director_messages = [dict(message) for message in messages]
    for message in director_messages:
        if message.get("role") != "user":
            continue
        message["content"] = _message_without_voice_id_directive(
            strip_command(str(message.get("content") or ""))
        )
    return director_messages


def _selected_voice_id(req: ChatRequest, project: dict[str, Any]) -> str:
    plan = project.get("plan") if isinstance(project.get("plan"), dict) else {}
    candidates = (
        _explicit_voice_id(req.message),
        req.voiceId,
        project.get("voiceId"),
        plan.get("voice_id"),
        settings.minimax_voice_id,
    )
    for candidate in candidates:
        voice_id = _normalize_voice_id(candidate)
        if voice_id:
            return voice_id
    return ""


def _apply_asset_plan(plan: dict[str, Any], assets: list[dict[str, Any]]) -> str:
    assignments = list(plan.get("asset_assignments") or [])
    by_id = {str(item.get("asset_id") or ""): item for item in assignments if isinstance(item, dict)}
    by_label = {str(item.get("label") or ""): item for item in assignments if isinstance(item, dict)}
    normalized: list[dict[str, Any]] = []
    reference_images: list[dict[str, Any]] = []
    material_assets: list[dict[str, Any]] = []
    narration_assets: list[dict[str, Any]] = []
    bgm_assets: list[dict[str, Any]] = []
    sfx_assets: list[dict[str, Any]] = []
    summary_parts: list[str] = []
    role_labels = {
        "reference": "生成参考",
        "material": "剪辑素材",
        "both": "参考并剪辑",
        "narration": "口播主音轨",
        "bgm": "背景音乐",
        "sfx": "局部音效",
        "unused": "暂不使用",
    }

    def safe_number(value: Any, default: float) -> float:
        try:
            result = float(value)
        except (TypeError, ValueError, OverflowError):
            return default
        return result if math.isfinite(result) else default

    scene_count = max(1, len(plan.get("scenes") or []))
    for index, asset in enumerate(assets):
        assignment = by_id.get(str(asset.get("asset_id") or "")) or by_label.get(str(asset.get("label") or "")) or {}
        media_type = str(asset.get("media_type") or "")
        default_role = "reference" if media_type == "image" else "material" if media_type == "video" else "narration"
        role = str(assignment.get("role") or default_role)
        allowed_roles = {
            "image": {"reference", "material", "both", "unused"},
            "video": {"material", "unused"},
            "audio": {"narration", "bgm", "sfx", "unused"},
        }.get(media_type, {"unused"})
        if role not in allowed_roles:
            role = default_role
        scene_value = safe_number(assignment.get("scene_number"), index % scene_count + 1)
        scene_number = max(1, min(scene_count, int(scene_value)))
        merged = {
            **{key: value for key, value in asset.items() if key != "visionDataUrl"},
            "role": role,
            "presentation": str(assignment.get("presentation") or "auto"),
            "position": str(assignment.get("position") or "top-right"),
            "scale": max(0.1, min(0.65, safe_number(assignment.get("scale"), 0.36))),
            "scene_number": scene_number,
            "narration_anchor": str(assignment.get("narration_anchor") or "")[:80],
            "duration_sec": max(0.5, safe_number(assignment.get("duration_sec"), 3.6)),
            "source_start_sec": max(0.0, safe_number(assignment.get("source_start_sec"), 0.0)),
            "volume": max(0.0, min(1.5, safe_number(assignment.get("volume"), 0.72 if role == "sfx" else 1.0))),
            "reason": str(assignment.get("reason") or role_labels[role])[:220],
        }
        asset_name = str(asset.get("name") or "").lower()
        is_logo = media_type == "image" and any(
            marker in asset_name for marker in ("logo", "标志", "徽标", "角标", "水印", "icon")
        )
        if is_logo:
            merged["presentation"] = "overlay"
            merged["position"] = (
                merged["position"]
                if merged["position"] in {"top-left", "top-right", "bottom-left", "bottom-right"}
                else "top-right"
            )
            merged["scale"] = min(0.3, max(0.14, safe_number(assignment.get("scale"), 0.22)))
        elif merged["presentation"] not in {"overlay", "pip", "cutaway"}:
            merged["presentation"] = "pip" if media_type in {"image", "video"} else "cutaway"
        normalized.append(merged)
        summary_parts.append(f"{asset.get('label')}：{role_labels[role]}")
        if role in {"reference", "both"} and str(asset.get("mime") or "").startswith("image/"):
            reference_images.append({key: asset[key] for key in ("asset_id", "label", "name", "mime", "url") if key in asset})
        if role in {"material", "both"} and media_type in {"image", "video"}:
            material_assets.append(merged)
        if role == "narration" and media_type == "audio" and not narration_assets:
            narration_assets.append(merged)
        if role == "bgm" and media_type == "audio":
            bgm_assets.append(merged)
        if role == "sfx" and media_type == "audio":
            sfx_assets.append(merged)
    plan["asset_assignments"] = normalized
    plan["reference_images"] = reference_images[:3]
    plan["material_assets"] = material_assets
    plan["narration_audio"] = narration_assets[0] if narration_assets else None
    plan["bgm_assets"] = bgm_assets
    plan["sfx_assets"] = sfx_assets
    if bgm_assets:
        plan.setdefault("audio_design", {})["bgm_enabled"] = True
    return "；".join(summary_parts)


def _missing_asset_labels(message: str, assets: list[dict[str, Any]]) -> list[str]:
    available = {re.sub(r"\s+", "", str(item.get("label") or "")) for item in assets}
    referenced: set[str] = set()
    for clause in re.split(r"[，,。；;\n]+", message):
        if re.search(r"(?:忽略|不用|不使用|跳过|不管)", clause):
            continue
        referenced.update(f"{kind}{number}" for kind, number in re.findall(r"(图|视频|音频)\s*(\d+)", clause))
    return sorted(label for label in referenced if label not in available)


def _narration_candidate(message: str, assets: list[dict[str, Any]]) -> dict[str, Any] | None:
    audio_assets = [item for item in assets if item.get("media_type") == "audio" and not item.get("transcript")]
    if not audio_assets:
        return None
    compact = re.sub(r"\s+", "", message).lower()
    if any(marker in compact for marker in ("背景音乐", "配乐", "bgm", "音效", "素材音频")) and not any(
        marker in compact for marker in ("口播", "旁白", "语音", "主音轨")
    ):
        return None
    explicit_labels = re.findall(r"音频(\d+).{0,12}(?:口播|旁白|语音|主音轨)", compact)
    if explicit_labels:
        label = f"音频{explicit_labels[-1]}"
        return next((item for item in audio_assets if item.get("label") == label), None)
    if len(audio_assets) == 1:
        return audio_assets[0]
    return None


async def _transcribe_candidate(project_id: str, message: str) -> str:
    project = await asyncio.to_thread(load_project, project_id)
    candidate = _narration_candidate(message, list((project or {}).get("assets") or []))
    if not candidate:
        return ""
    source = settings.uploads_dir / project_id / Path(str(candidate.get("url") or "")).name
    await asyncio.to_thread(
        add_event,
        project_id,
        f"正在听取 {candidate.get('label')}",
        "先转写口播和时间戳，再让导演按真实语义与时长拆分镜头。",
        "running",
        5,
        "brief",
    )
    result = await asyncio.to_thread(
        transcriber.transcribe,
        source,
        settings.outputs_dir / project_id / "transcript",
    )

    def save_transcript(item: dict[str, Any]) -> None:
        for asset in item.get("assets") or []:
            if asset.get("asset_id") == candidate.get("asset_id"):
                asset["transcript"] = result

    await asyncio.to_thread(mutate_project, project_id, save_transcript)
    await asyncio.to_thread(
        add_event,
        project_id,
        "口播音频已转写",
        f"识别到约 {result.get('duration') or candidate.get('duration') or 0} 秒口播，原音频将作为成片主时间线。",
        "running",
        7,
        "brief",
    )
    return str(result.get("text") or "")


@app.get("/")
async def index():
    return FileResponse(settings.web_dir / "index.html")


@app.get("/api/health")
async def health():
    bgm_catalog = bgm_library.catalog()
    services = {
        "director": {
            "label": "导演语言模型",
            "configured": bool(settings.llm_api_key),
            "required": True,
            "model": settings.llm_model,
            "thinking": settings.llm_thinking,
            "skill": SKILL_NAME,
        },
        "video": {
            "label": "视频生成",
            "configured": bool(settings.seedance_api_key),
            "required": True,
            "model": settings.seedance_model,
        },
        "voice": {
            "label": "语音生成",
            "configured": bool(settings.minimax_api_key),
            "required": True,
            "model": settings.minimax_tts_model,
            "voiceId": settings.minimax_voice_id,
            "groupIdConfigured": bool(getattr(settings, "minimax_group_id", "")),
        },
        "mediaTools": {
            "label": "本地视频合成",
            "configured": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
            "required": True,
        },
        "qualityCheck": {
            "label": "成片质检",
            "configured": openmontage.available,
            "required": True,
        },
        "transcription": {
            "label": "口播音频转写",
            "configured": transcriber.available,
            "required": False,
            "model": settings.asr_model,
        },
        "bgm": {
            "label": "共享 BGM",
            "configured": bool(bgm_catalog),
            "required": False,
            "source": settings.bgm_source,
            "trackCount": len(bgm_catalog),
        },
    }
    missing_required = [
        item["label"]
        for item in services.values()
        if item.get("required") and not item.get("configured")
    ]
    optional_unavailable = [
        item["label"]
        for item in services.values()
        if not item.get("required") and not item.get("configured")
    ]
    status = "incomplete" if missing_required else (
        "degraded" if optional_unavailable else "ready"
    )
    return {
        "ok": True,
        "live": settings.live,
        "ready": not missing_required,
        "status": status,
        "missingRequired": missing_required,
        "optionalUnavailable": optional_unavailable,
        "services": services,
    }


@app.get("/api/projects")
async def project_list():
    items = await asyncio.to_thread(list_project_summaries)
    recovered = False
    for item in items:
        project_id = str(item.get("id") or "")
        if (
            project_id
            and item.get("status") == "running"
            and not _project_has_active_work(project_id)
        ):
            try:
                await asyncio.to_thread(
                    _mark_orphaned_running_project,
                    project_id,
                )
            except KeyError:
                continue
            recovered = True
    if recovered:
        items = await asyncio.to_thread(list_project_summaries)
    return {"items": items}


@app.get("/api/projects/{project_id}")
async def project_detail(project_id: str):
    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    if (
        project.get("status") == "running"
        and not _project_has_active_work(project_id)
    ):
        project = await asyncio.to_thread(
            _mark_orphaned_running_project,
            project_id,
        )
    return _project_response(project)


@app.patch("/api/projects/{project_id}")
async def project_rename(project_id: str, req: RenameProjectRequest):
    name = " ".join(req.name.split()).strip()
    if not name:
        raise HTTPException(400, "会话名称不能为空")

    def rename(project: dict[str, Any]) -> None:
        project["name"] = name[:60]

    try:
        project = await asyncio.to_thread(mutate_project, project_id, rename)
    except KeyError:
        raise HTTPException(404, "项目不存在")
    return {"ok": True, "id": project_id, "name": project["name"]}


@app.post("/api/projects/{project_id}/retry")
async def project_retry(project_id: str):
    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    if (
        project.get("status") == "running"
        and not _project_has_active_work(project_id)
    ):
        project = await asyncio.to_thread(
            _mark_orphaned_running_project,
            project_id,
        )
    if project.get("status") == "running":
        raise HTTPException(409, "当前项目正在处理")
    if _project_has_active_work(project_id):
        raise HTTPException(409, "当前项目正在处理")
    retryable = _retry_info(project)
    if project.get("status") != "failed" or not retryable:
        raise HTTPException(409, "当前失败不支持安全改写重试")
    plan = project.get("plan")
    if not isinstance(plan, dict) or not plan.get("scenes"):
        raise HTTPException(409, "导演计划不完整，无法恢复")

    scene_number = int(retryable["sceneNumber"])
    previous_error = str(project.get("error") or "")
    previous_progress = int(project.get("progress") or 0)
    is_copyright_rewrite = retryable.get("reason") == "copyright"

    if retryable.get("type") == "resume_missing":
        with _launching_project(project_id):
            def mark_resuming(item: dict[str, Any]) -> None:
                item["status"] = "running"
                item["phase"] = "recovery"
                item["progress"] = max(12, min(58, previous_progress))
                item["error"] = ""
                item["retryable"] = None

            await asyncio.to_thread(mutate_project, project_id, mark_resuming)
            await asyncio.to_thread(
                add_event,
                project_id,
                f"正在从镜头 {scene_number} 恢复未完成镜头",
                "已保留完成的口播与视频素材，将继续所有缺失镜头。",
                "running",
                max(12, min(58, previous_progress)),
                "recovery",
            )
            await asyncio.to_thread(
                add_message,
                project_id,
                "assistant",
                f"已恢复制作任务。本次从缺失镜头 {scene_number} 开始继续所有未完成镜头，"
                "已完成的口播和视频素材不会重复生成。",
                kind="retry",
            )
            _schedule(project_id, plan, retry_scene_number=scene_number)
            return _project_response(await asyncio.to_thread(load_project, project_id))

    with _launching_project(project_id):
        def mark_rewriting(item: dict[str, Any]) -> None:
            item["status"] = "running"
            item["phase"] = "recovery"
            item["progress"] = max(12, min(55, previous_progress))
            item["error"] = ""
            item["retryable"] = None

        await asyncio.to_thread(mutate_project, project_id, mark_rewriting)
        await asyncio.to_thread(
            add_event,
            project_id,
            f"导演正在{'原创' if is_copyright_rewrite else '安全'}改写镜头 {scene_number}",
            (
                "保留原叙事功能，移除可识别人物、作品风格、品牌和受保护设计。"
                if is_copyright_rewrite
                else "保留原叙事功能，移除可能触发审核的身份、品牌和夸张隐喻。"
            ),
            "running",
            max(12, min(55, previous_progress)),
            "recovery",
        )
        try:
            rewrite = await director.rewrite_scene_for_safety(
                plan,
                scene_number,
                str(retryable.get("reason") or "safety"),
            )
        except ProviderError as exc:
            def restore_failure(item: dict[str, Any]) -> None:
                item["status"] = "failed"
                item["phase"] = "error"
                item["error"] = previous_error or str(exc)
                item["retryable"] = retryable

            await asyncio.to_thread(mutate_project, project_id, restore_failure)
            await asyncio.to_thread(
                add_event,
                project_id,
                "安全改写未完成",
                str(exc),
                "error",
                None,
                "error",
            )
            raise HTTPException(502, str(exc))

        original_prompt = str(plan["scenes"][scene_number - 1].get("visual_prompt") or "")
        plan["scenes"][scene_number - 1]["visual_prompt"] = rewrite["visual_prompt"]
        attempts = int((project.get("retry") or {}).get("attempt") or 0) + 1
        retry_record = {
            "attempt": attempts,
            "sceneNumber": scene_number,
            "originalPrompt": original_prompt,
            "rewrittenPrompt": rewrite["visual_prompt"],
            "changeSummary": rewrite["change_summary"],
            "publicThought": rewrite["public_thought"],
        }

        def save_rewrite(item: dict[str, Any]) -> None:
            item["plan"] = plan
            item["retry"] = retry_record
            item["status"] = "running"
            item["phase"] = "production"
            item["retryable"] = None

        await asyncio.to_thread(mutate_project, project_id, save_rewrite)
        await asyncio.to_thread(
            add_event,
            project_id,
            "原创改写已完成" if is_copyright_rewrite else "安全改写已完成",
            rewrite["change_summary"],
            "running",
            max(18, min(58, previous_progress)),
            "recovery",
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            f"已完成镜头 {scene_number} 的{'原创' if is_copyright_rewrite else '安全'}改写。"
            f"{rewrite['public_thought']}本次只重试失败镜头，已成功的配音和视频素材会继续复用。",
            kind="retry",
        )
        _schedule(project_id, plan, retry_scene_number=scene_number)
        return _project_response(await asyncio.to_thread(load_project, project_id))


@app.post("/api/projects/{project_id}/cancel")
async def project_cancel(project_id: str):
    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    if (
        project.get("status") == "stopped"
        or (
            project.get("status") == "failed"
            and project.get("phase") == "stopped"
        )
    ):
        return _project_response(project)
    if project.get("status") != "running":
        raise HTTPException(409, "当前项目没有正在执行的制作任务")

    task = _project_tasks.get(project_id)
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    if project.get("status") != "running":
        return _project_response(project)

    retryable = _retry_info(project)
    resumable = bool(retryable and retryable.get("type") == "resume_missing")
    scene_number = int((retryable or {}).get("sceneNumber") or 0)
    message = (
        "制作已按请求停止。已经完成的口播和镜头文件会保留，"
        f"稍后可从缺失镜头 {scene_number} 继续。"
        if resumable
        else (
            "制作已按请求停止。已完成的本地文件会保留；"
            "当前链路不伪装为可无损暂停，可以补充方向后重新发起制作。"
        )
    )

    def mark_stopped(item: dict[str, Any]) -> None:
        item["status"] = "failed" if resumable else "stopped"
        item["phase"] = "stopped"
        item["error"] = message if resumable else ""
        item["retryable"] = retryable if resumable else None

    await asyncio.to_thread(mutate_project, project_id, mark_stopped)
    await asyncio.to_thread(
        add_event,
        project_id,
        "制作已停止",
        message,
        "done",
        None,
        "stopped",
    )
    await asyncio.to_thread(
        add_message,
        project_id,
        "assistant",
        message,
        kind="retry" if resumable else "message",
    )
    return _project_response(await asyncio.to_thread(load_project, project_id))


@app.post("/api/chat")
async def chat(req: ChatRequest):
    project = await asyncio.to_thread(load_project, req.projectId) if req.projectId else None
    if project is None:
        project = await asyncio.to_thread(create_project)
    if project.get("status") == "running":
        raise HTTPException(409, "当前项目仍在制作，请等待完成")
    try:
        selected_voice_id = _selected_voice_id(req, project)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    def remember_voice(item: dict[str, Any]) -> None:
        item["voiceId"] = selected_voice_id

    await asyncio.to_thread(mutate_project, project["id"], remember_voice)
    project["voiceId"] = selected_voice_id

    previous_user_text = "\n".join(
        str(message.get("content") or "")
        for message in project.get("messages") or []
        if message.get("role") == "user"
    )
    aspect_ratio = _infer_aspect_ratio(f"{previous_user_text}\n{req.message}")
    decoded_attachments = await asyncio.to_thread(_decode_attachments, req.attachments)

    existing_assets = list(project.get("assets") or [])
    saved_attachments = _save_attachments(project["id"], decoded_attachments, existing_assets)
    saved_attachments = await _enrich_saved_attachments(project["id"], saved_attachments)

    if saved_attachments:
        def append_assets(item: dict[str, Any]) -> None:
            item["assets"] = [*(item.get("assets") or []), *saved_attachments]

        await asyncio.to_thread(mutate_project, project["id"], append_assets)
    await asyncio.to_thread(
        add_message,
        project["id"],
        "user",
        req.message.strip(),
        attachments=saved_attachments,
    )

    def name_from_first_message(item: dict[str, Any]) -> None:
        if not item.get("name") or item.get("name") == "新会话":
            item["name"] = req.message.strip().replace("\n", " ")[:28]

    await asyncio.to_thread(mutate_project, project["id"], name_from_first_message)
    try:
        await _transcribe_candidate(project["id"], req.message)
    except TranscriptionError as exc:
        question = f"{exc}。你可以重新上传音频，或同时粘贴口播文本继续。"
        await asyncio.to_thread(
            add_message,
            project["id"],
            "assistant",
            question,
            kind="question",
            suggestions=["我重新上传口播音频", "我直接粘贴口播文本", "这个音频不是口播，作为素材继续"],
        )
        await asyncio.to_thread(
            add_event,
            project["id"],
            "等待可用口播",
            str(exc),
            "waiting",
            5,
            "brief",
        )
        return await asyncio.to_thread(load_project, project["id"])
    await asyncio.to_thread(
        add_event,
        project["id"],
        "导演正在判断信息是否完整",
        "正在组织受众、叙事、口播、附件用途和最合适的镜头结构。",
        "running",
        4,
        "brief",
    )
    project = await asyncio.to_thread(load_project, project["id"])
    director_assets = await asyncio.to_thread(
        _hydrate_assets_for_director,
        project["id"],
        list(project.get("assets") or []),
    )
    missing_labels = _missing_asset_labels(req.message, director_assets)
    if missing_labels:
        missing_text = "、".join(missing_labels)
        question = f"我没有找到你提到的 {missing_text}。你想补充上传，还是忽略这些编号继续？"
        suggestions = [f"我重新上传 {missing_text}", f"忽略 {missing_text} 继续", "按现有素材自动调整"]
        await asyncio.to_thread(
            add_message,
            project["id"],
            "assistant",
            question,
            kind="question",
            suggestions=suggestions,
        )
        await asyncio.to_thread(
            add_event,
            project["id"],
            "等待确认附件编号",
            f"用户提到了未上传的 {missing_text}。",
            "waiting",
            5,
            "brief",
        )
        return await asyncio.to_thread(load_project, project["id"])
    try:
        director_messages = _director_messages_without_voice_id_directives(
            project["messages"]
        )
        decision = await director.decide(
            director_messages,
            aspect_ratio,
            director_assets,
            skill_context=director_context(),
            bgm_catalog=bgm_library.catalog(),
        )
    except ProviderError as exc:
        await asyncio.to_thread(
            add_event,
            project["id"],
            "导演连接失败",
            str(exc),
            "error",
            None,
            "brief",
        )
        raise HTTPException(502, str(exc))

    if decision["action"] == "ask":
        await asyncio.to_thread(
            add_message,
            project["id"],
            "assistant",
            decision["question"],
            kind="question",
            suggestions=decision.get("suggestions") or [],
        )
        await asyncio.to_thread(
            add_event,
            project["id"],
            "等待补充关键信息",
            "导演只保留了一个会显著影响成片的问题。",
            "waiting",
            6,
            "brief",
        )
        return await asyncio.to_thread(load_project, project["id"])

    plan = decision["plan"]
    plan["skill"] = SKILL_NAME
    plan["voice_id"] = selected_voice_id
    asset_summary = _apply_asset_plan(plan, list(project.get("assets") or []))
    narration_asset = plan.get("narration_audio") or {}
    transcript_text = str((narration_asset.get("transcript") or {}).get("text") or "").strip()
    if transcript_text:
        plan["narration"] = transcript_text
        plan["input_mode"] = "audio"
    if asset_summary:
        await asyncio.to_thread(
            add_event,
            project["id"],
            "附件用途已确认",
            asset_summary,
            "running",
            8,
            "brief",
        )

    with _launching_project(project["id"]):
        def mark_running(item: dict[str, Any]) -> None:
            item["status"] = "running"
            item["phase"] = "production"
            item["progress"] = 10
            item["plan"] = plan
            item["error"] = ""

        await asyncio.to_thread(mutate_project, project["id"], mark_running)
        await asyncio.to_thread(
            add_message,
            project["id"],
            "assistant",
            f"信息够了。我会用“{plan['title']}”这个方向制作：{plan.get('director_note') or '镜头结构和节奏将按口播内容展开。'}",
            kind="plan",
        )
        _schedule(project["id"], plan)
        return await asyncio.to_thread(load_project, project["id"])


@app.post("/api/test/director")
async def test_director():
    decision = await director.decide(
        [
            {
                "role": "user",
                "content": "制作一条介绍星阵智能视频导演台的竖屏视频，面向内容创作者，强调对话后自动完成导演、配音、生成、字幕与质检，时长和镜头由导演按表达需要决定。",
            }
        ],
        "9:16",
        [],
        skill_context=director_context(),
        bgm_catalog=bgm_library.catalog(),
    )
    return {"ok": True, "action": decision["action"], "sceneCount": len((decision.get("plan") or {}).get("scenes") or [])}


@app.post("/api/test/voice")
async def test_voice(req: VoiceTestRequest = None):
    try:
        voice_id = _normalize_voice_id(
            (req.voiceId if req is not None else "") or settings.minimax_voice_id
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if not voice_id:
        raise HTTPException(400, "请填写音色 ID")
    target = settings.outputs_dir / "voice-smoke.mp3"
    result = await tts.generate(
        "星阵视频导演台，语音连接测试成功。",
        target,
        voice_id=voice_id,
    )
    return {
        "ok": True,
        "url": "/outputs/voice-smoke.mp3",
        "durationMs": result.get("durationMs", 0),
        "voiceId": result.get("voiceId") or voice_id,
    }
