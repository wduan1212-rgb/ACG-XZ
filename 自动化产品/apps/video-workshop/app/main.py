from __future__ import annotations

import asyncio
import base64
import json
import math
import mimetypes
import os
import re
import shutil
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, conlist

from .bgm import bgm_library
from .config import settings
from .media import MediaError, extract_video_preview, probe
from .openmontage_bridge import openmontage
from .pipeline import _scene_output_exists, _scene_output_paths, pipeline
from .providers import ProviderError, director, seedance, tts
from .sfx import sfx_library
from .store import add_event, add_message, create_project, list_project_summaries, load_project, mutate_project
from .transcription import TranscriptionError, transcriber
from .usage_receipts import project_usage_scope
from .video_skill import SKILL_NAME, director_context, strip_command


app = FastAPI(title="星阵视频导演台", version="0.1.0")
app.mount("/assets", StaticFiles(directory=settings.web_dir / "assets"), name="assets")
app.mount("/outputs", StaticFiles(directory=settings.outputs_dir), name="outputs")
app.mount("/uploads", StaticFiles(directory=settings.uploads_dir), name="uploads")

VIDEO_WORKSHOP_CONTRACT_VERSION = "video-workshop-v137-read-only-1"
VIDEO_WORKSHOP_BUILD_ID = "20260817-v1436-token-plan-knowledge-1"


def _runtime_read_only() -> bool:
    return str(os.getenv("ACG_READ_ONLY", "") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }


@app.middleware("http")
async def enforce_runtime_read_only(request: Request, call_next):
    """Deny every sidecar mutation while a protected release is inspected.

    The sidecar is loopback-only, but it owns durable project JSON and media.
    Enforcing the same flag here prevents a direct loopback request from
    bypassing the main service maintenance gate.
    """

    if _runtime_read_only() and request.method.upper() not in {
        "GET", "HEAD", "OPTIONS",
    }:
        return JSONResponse(
            status_code=503,
            content={"detail": "视频工坊正在受保护的只读验收模式"},
            headers={"Retry-After": "60", "Cache-Control": "no-store"},
        )
    return await call_next(request)

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


def _bounded_list_type(item_type: Any, *, minimum: int, maximum: int):
    """Keep list bounds enforced on both locked Pydantic runtimes."""

    try:
        return conlist(item_type, min_length=minimum, max_length=maximum)
    except TypeError:
        return conlist(item_type, min_items=minimum, max_items=maximum)


AttachmentBatch = _bounded_list_type(Attachment, minimum=1, maximum=8)


class ProjectAssetUploadRequest(BaseModel):
    attachments: AttachmentBatch


class ChatRequest(BaseModel):
    projectId: str = ""
    message: str = Field(min_length=1, max_length=8000)
    aspectRatio: str = ""
    creationMode: str = Field(default="video", max_length=24)
    voiceId: str = Field(default="", max_length=180)
    attachments: list[Attachment] = Field(default_factory=list)
    billingReservationId: str = Field(default="", max_length=180)
    billingOwnerId: str = Field(default="", max_length=180)
    billingPointLimit: int = Field(default=0, ge=0, le=1000000)
    billingBypassed: bool = False


class RenameProjectRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class VoiceTestRequest(BaseModel):
    voiceId: str = Field(default="", max_length=180)


class SpeedVersionRequest(BaseModel):
    outputId: str = Field(min_length=1, max_length=180)
    speed: float = Field(ge=1.2, le=2.0)


class TimelineClipEdit(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    sourceFile: str = Field(min_length=1, max_length=255)
    sourceSceneNumber: int = Field(ge=1, le=500)
    segmentNumber: int = Field(default=1, ge=1, le=500)
    segmentCount: int = Field(default=1, ge=1, le=500)
    duration: float = Field(ge=0.25, le=120)
    trimStart: float = Field(default=0, ge=0, le=7200)
    subtitle: str = Field(default="", max_length=1200)
    replacementAssetId: str = Field(default="", max_length=500)
    transition: str = Field(default="fade", max_length=24)


class TimelineOverlayEdit(BaseModel):
    assetId: str = Field(min_length=1, max_length=500)
    start: float = Field(default=0, ge=0, le=7200)
    duration: float = Field(default=3.6, ge=0.5, le=7200)
    position: str = Field(default="top-right", max_length=24)
    positionX: float = Field(default=1.0, ge=0, le=1)
    positionY: float = Field(default=0.0, ge=0, le=1)
    scale: float = Field(default=0.32, ge=0.1, le=0.65)
    entryEffect: str = Field(default="fade", max_length=24)
    exitEffect: str = Field(default="fade", max_length=24)


class TimelineSoundEffectEdit(BaseModel):
    id: str = Field(min_length=1, max_length=120)
    sourceType: str = Field(default="catalog", max_length=24)
    sourceId: str = Field(min_length=1, max_length=500)
    label: str = Field(default="音效", max_length=180)
    start: float = Field(default=0, ge=0, le=7200)
    duration: float = Field(default=0.5, ge=0.1, le=7200)
    volume: float = Field(default=0.72, ge=0, le=1.5)


TimelineClipBatch = _bounded_list_type(TimelineClipEdit, minimum=1, maximum=120)
TimelineOverlayBatch = _bounded_list_type(TimelineOverlayEdit, minimum=0, maximum=24)
TimelineSoundEffectBatch = _bounded_list_type(TimelineSoundEffectEdit, minimum=0, maximum=80)


class TimelineRevisionRequest(BaseModel):
    outputId: str = Field(min_length=1, max_length=180)
    clips: TimelineClipBatch
    overlays: TimelineOverlayBatch = Field(default_factory=list)
    soundEffects: TimelineSoundEffectBatch = Field(default_factory=list)
    bgmSelection: str = Field(default="keep", max_length=540)
    narrationVolume: float = Field(default=1.0, ge=0, le=2)
    bgmVolume: float = Field(default=0.12, ge=0, le=1)
    subtitleEffect: str = Field(default="", max_length=40)


def _track_project_task(project_id: str, awaitable: Any) -> bool:
    current = _project_tasks.get(project_id)
    if current is not None and not current.done():
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        return False
    task = asyncio.create_task(awaitable)
    _tasks.add(task)
    _project_tasks[project_id] = task

    def clear(completed: asyncio.Task[Any]) -> None:
        # Consume unexpected task exceptions so a detached browser request can
        # never turn them into an unobserved asyncio warning. Expected provider
        # and pipeline failures are persisted by their own handlers.
        if not completed.cancelled():
            try:
                completed.exception()
            except Exception:
                pass
        _tasks.discard(completed)
        if _project_tasks.get(project_id) is completed:
            _project_tasks.pop(project_id, None)

    task.add_done_callback(clear)
    return True


def _schedule(
    project_id: str,
    plan: dict[str, Any],
    retry_scene_number: int | None = None,
    *,
    recompose_only: bool = False,
) -> bool:
    run_options = {"retry_scene_number": retry_scene_number}
    if recompose_only:
        run_options["recompose_only"] = True
    return _track_project_task(
        project_id,
        _run_pipeline_with_auto_policy(project_id, plan, **run_options),
    )


def _latest_actionable_failure(project: dict[str, Any]) -> str:
    """Recover the last unfinished pipeline error even after a chat reply reset the shell state."""
    direct = str(project.get("error") or "").strip()
    if direct:
        return direct
    for message in reversed(project.get("messages") or []):
        if message.get("role") != "assistant":
            continue
        kind = str(message.get("kind") or "")
        if kind == "delivery":
            break
        if kind == "error":
            return str(message.get("content") or "").strip()
    return ""


def _is_continue_request(message: str) -> bool:
    compact = re.sub(r"[\s，。！？、,.!?]+", "", str(message or "")).lower()
    if compact in {
        "继续",
        "继续制作",
        "继续生成",
        "继续合成",
        "继续执行",
        "继续完成",
        "确认继续",
        "按这个做",
        "执行吧",
        "开始吧",
        "没关系继续",
        "没关系继续合成",
        "不用管继续",
        "不用管继续合成",
    }:
        return True
    return bool(
        re.fullmatch(
            r"(?:没关系|不用管|无所谓|这个误差没关系)?(?:请)?继续(?:制作|生成|合成|执行|完成)?",
            compact,
        )
    )


def _retry_info(project: dict[str, Any]) -> dict[str, Any] | None:
    scenes = list((project.get("plan") or {}).get("scenes") or [])
    scene_count = len(scenes)
    retryable = project.get("retryable")
    if isinstance(retryable, dict) and retryable.get("type") in {
        "safe_rewrite",
        "resume_missing",
        "resume_plan",
        "recompose",
    }:
        scene_number = int(retryable.get("sceneNumber") or 0)
        if 1 <= scene_number <= scene_count:
            result = {"type": retryable["type"], "sceneNumber": scene_number}
            reason = str(retryable.get("reason") or "")
            if reason:
                result["reason"] = reason
            return result
    error = _latest_actionable_failure(project)
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
        if not _scene_output_exists(project.get("plan"), work_dir, scene_number)
    ]
    if project_id and narration_exists and missing_scenes:
        return {"type": "resume_missing", "sceneNumber": missing_scenes[0]}
    if (
        project_id
        and narration_exists
        and scene_count
        and not missing_scenes
        and any(marker in error for marker in ("音画时长不一致", "合成前检查失败", "成片质检未通过"))
    ):
        return {"type": "recompose", "sceneNumber": 1}
    return None


_CHINESE_SCENE_NUMBERS = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
}


def _scene_number(value: str) -> int:
    token = str(value or "").strip()
    if token.isdigit():
        return int(token)
    direct = _CHINESE_SCENE_NUMBERS.get(token)
    if direct is not None:
        return direct
    # 视频工坊通常只有少量镜头，但兼容“第十二个镜头、二十一号片段”
    # 等自然表达。拒绝“一二”这类不规范串，避免猜错后修改错误镜头。
    if token.count("十") == 1:
        tens, units = token.split("十", 1)
        if len(tens) > 1 or len(units) > 1:
            return 0
        tens_value = 1 if not tens else _CHINESE_SCENE_NUMBERS.get(tens, -1)
        units_value = 0 if not units else _CHINESE_SCENE_NUMBERS.get(units, -1)
        if 1 <= tens_value <= 9 and 0 <= units_value <= 9:
            return tens_value * 10 + units_value
    return 0


def _requested_scene_number(text: str) -> int | None:
    number = r"(?:[0-9]+|[零〇一二两三四五六七八九十]+)"
    patterns = (
        rf"(?:镜头|片段|视频)\s*(?:第\s*)?({number})(?:\s*(?:号|个))?",
        rf"第\s*({number})\s*(?:个|号)?\s*(?:镜头|片段|视频)",
        rf"({number})\s*号\s*(?:镜头|片段|视频)",
    )
    for pattern in patterns:
        matched = re.search(pattern, text)
        if matched:
            return _scene_number(matched.group(1))
    return None


def _local_revision_request(
    message: str,
    plan: dict[str, Any] | None,
    current_assets: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Recognize safe, local edits without turning ordinary chat into a rebuild."""
    if not isinstance(plan, dict) or not plan.get("scenes") or current_assets:
        return None
    text = re.sub(r"\s+", "", str(message or ""))
    if not text:
        return None
    scene_number = _requested_scene_number(text)
    if scene_number is None and re.search(
        r"新做|新生成|再做|另做|从头做|做一条新|做一个新|做不同版本|新视频|新成片",
        text,
    ):
        # A new creative request in an existing conversation belongs to the
        # director.  Never reinterpret quantities such as "3个镜头" as a
        # request to mutate scene 3 of the previous delivery.
        return None
    revision_markers = (
        "修改",
        "调整",
        "重做",
        "重新生成",
        "重新做",
        "重新编排",
        "替换",
        "换掉",
        "换一下",
        "换成",
        "换为",
        "更换",
        "改一下",
        "改成",
        "改为",
        "变成",
        "恢复",
        "不满意",
        "不对",
        "不自然",
        "有瑕疵",
        "有问题",
        "错了",
    )

    if "字幕" in text:
        layout_markers = (
            "字号",
            "字体",
            "太大",
            "太小",
            "大一点",
            "小一点",
            "放大",
            "缩小",
            "靠上",
            "靠下",
            "上移",
            "下移",
            "位置",
            "排版",
            "编排",
            "分句",
            "断句",
            "每行",
            "一行",
            "两行",
            "行数",
            "动效",
            "动画",
            "颜色",
            "描边",
            "阴影",
            "透明度",
            "安全区",
            "红色",
            "白色",
            "黄色",
            "黑色",
        )
        has_layout_request = any(marker in text for marker in layout_markers)
        changes_spoken_text = bool(
            re.search(
                r"字幕(?:文字|内容|文案|台词)(?:需要)?(?:修改|改|换|替换|变)(?:成|为)",
                text,
            )
            or re.search(r"把字幕(?:文字|内容|文案|台词)(?:修改|改|换|替换)(?:成|为)", text)
            or re.search(
                r"字幕(?:文字|内容|文案|台词)?(?:和|与|跟)(?:口播|配音|声音)"
                r"(?:不太一致|不太一样|不一致|不一样|不同|对不上|不匹配)",
                text,
            )
            or any(
                marker in text
                for marker in (
                    "替换字幕文字",
                    "修改字幕文案",
                    "修改字幕内容",
                    "字幕文字不对",
                    "字幕内容不对",
                    "字幕文案不对",
                    "字幕错了",
                    "字幕有错",
                    "字幕识别错",
                    "字幕漏字",
                    "字幕错字",
                    "字幕多字",
                    "字幕少字",
                    "字幕不是口播",
                )
            )
        )
        if not changes_spoken_text and re.search(r"把字幕(?:修改|改|换|替换)(?:成|为)", text):
            # “把字幕改成红色/小一点”属于样式；没有任何样式线索时，
            # 视为要改字幕正文，先询问是否同步重做口播。
            changes_spoken_text = not has_layout_request
        if not (
            changes_spoken_text
            or has_layout_request
            or any(marker in text for marker in revision_markers)
        ):
            return None
        return {
            "type": "subtitle_text" if changes_spoken_text else "subtitle_layout",
            "instruction": str(message or "").strip(),
        }

    motion_issue_markers = (
        "静止尾帧",
        "静止帧",
        "卡帧",
        "画面不动",
        "画面静止",
        "缺镜头",
        "少镜头",
    )
    has_revision_marker = any(marker in text for marker in revision_markers)
    has_motion_issue = any(marker in text for marker in motion_issue_markers)
    explicitly_remove_motion_issue = has_motion_issue and bool(
        re.search(r"去掉|移除|删除|消除|避免|修复|解决|不要有|不能有|重新补|补一下", text)
    )
    has_motion_marker = (
        explicitly_remove_motion_issue
        and not ("保留" in text and "不要删除" in text)
    )
    if not has_revision_marker and not has_motion_marker:
        return None
    number = scene_number
    if number is None and has_motion_marker:
        return {
            "type": "motion_recompose",
            "instruction": str(message or "").strip(),
        }
    if number is None:
        return None
    scene_count = len([item for item in plan.get("scenes") or [] if isinstance(item, dict)])
    if number < 1 or number > scene_count:
        return {"type": "invalid_scene", "sceneNumber": number, "sceneCount": scene_count}
    timeline_text = re.sub(
        r"(?:不改|不调整|保持|沿用|保留)(?:原有|原来的|当前)?"
        r"(?:口播|旁白|配音|声音|音色|语速|时长|BGM|bgm|背景音乐)",
        "",
        text,
    )
    if any(
        marker in timeline_text
        for marker in (
            "口播",
            "旁白",
            "配音",
            "声音",
            "音色",
            "语速",
            "时长",
            "几秒",
            "秒",
            "BGM",
            "bgm",
            "背景音乐",
        )
    ):
        return {
            "type": "timeline_change",
            "sceneNumber": number,
            "sceneCount": scene_count,
        }
    return {
        "type": "scene",
        "sceneNumber": number,
        "instruction": str(message or "").strip(),
    }


def _revision_message_for_continuation(
    project: dict[str, Any],
    current_message: str,
) -> str:
    compact = re.sub(r"\s+", "", str(current_message or "")).lower()
    if compact not in {
        "继续",
        "继续制作",
        "继续生成",
        "确认继续",
        "按这个做",
        "执行吧",
        "开始吧",
        "什么",
        "说啊",
        "然后呢",
    }:
        return current_message
    plan = project.get("plan") if isinstance(project.get("plan"), dict) else None
    if plan is None:
        return current_message
    filler_messages = {
        "继续",
        "继续制作",
        "继续生成",
        "确认继续",
        "按这个做",
        "执行吧",
        "开始吧",
        "什么",
        "说啊",
        "然后呢",
    }
    messages = [item for item in project.get("messages") or [] if isinstance(item, dict)]
    for item in reversed(messages[:-1]):
        if item.get("role") != "user":
            continue
        candidate = str(item.get("content") or "").strip()
        normalized = re.sub(r"\s+", "", candidate).lower()
        if normalized in filler_messages:
            continue
        if _local_revision_request(candidate, plan, []):
            return candidate
        # Replaying the last meaningful user intent is safer than forwarding a
        # context-free "继续/什么/说啊" to the director.  This does not add a
        # prompt rule or force a tool; the director receives the user's own text.
        return candidate
    return current_message


def _mark_orphaned_running_project(project_id: str) -> dict[str, Any]:
    def recover(project: dict[str, Any]) -> None:
        if project.get("status") != "running":
            return
        retryable = _retry_info(project)
        scenes = [
            item
            for item in (project.get("plan") or {}).get("scenes") or []
            if isinstance(item, dict)
        ]
        if not retryable and scenes:
            work_dir = settings.outputs_dir / project_id
            first_missing = next(
                (
                    scene_number
                    for scene_number in range(1, len(scenes) + 1)
                    if not _scene_output_exists(project.get("plan"), work_dir, scene_number)
                ),
                1,
            )
            retryable = {"type": "resume_plan", "sceneNumber": first_missing}
        resumable = bool(
            retryable
            and retryable.get("type") in {"resume_missing", "resume_plan"}
        )
        scene_number = int((retryable or {}).get("sceneNumber") or 0)
        if resumable:
            if retryable.get("type") == "resume_missing":
                public_error = (
                    "服务重启，已保留素材，将自动继续缺失镜头；"
                    f"从缺失镜头 {scene_number} 开始继续所有未完成镜头。"
                )
                event_title = "服务重启，已保留素材，正在自动继续"
            else:
                public_error = (
                    "服务重启，已保留原导演计划，将自动恢复上一轮制作；"
                    f"从镜头 {scene_number} 继续，不会新建任务或重新判断需求。"
                )
                event_title = "服务重启，正在恢复上一轮制作"
            project["retryable"] = retryable
            project["restartAutoResumeAttempted"] = False
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


async def _auto_resume_restart_project(
    project_id: str,
    project: dict[str, Any],
) -> dict[str, Any]:
    retryable = _retry_info(project)
    restart_recovery = any(
        item.get("recoveryType") == "service-restart"
        for item in [
            *(project.get("events") or []),
            *(project.get("messages") or []),
        ]
        if isinstance(item, dict)
    )
    if (
        project.get("status") != "failed"
        or not restart_recovery
        or project.get("restartAutoResumeAttempted")
        or not retryable
        or retryable.get("type") not in {"resume_missing", "resume_plan"}
    ):
        return project

    def mark_attempted(item: dict[str, Any]) -> None:
        item["restartAutoResumeAttempted"] = True

    await asyncio.to_thread(mutate_project, project_id, mark_attempted)
    try:
        return await project_retry(project_id)
    except HTTPException as exc:
        if exc.status_code == 409:
            latest = await asyncio.to_thread(load_project, project_id)
            return latest or project
        raise


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
_MAX_ATTACHMENTS_PER_MESSAGE = 8


def _decode_attachments(attachments: list[Attachment]) -> list[tuple[Attachment, str, bytes]]:
    if len(attachments) > _MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(400, "每条消息最多添加 8 个附件")
    decoded: list[tuple[Attachment, str, bytes]] = []
    total_bytes = 0
    for item in attachments:
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
) -> list[dict[str, Any]]:
    saved: list[dict[str, Any]] = []
    target_dir = settings.uploads_dir / project_id
    target_dir.mkdir(parents=True, exist_ok=True)
    image_count = 0
    video_count = 0
    audio_count = 0
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


def _infer_aspect_ratio(message: str, default: str = "9:16") -> str:
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
    fallback = default if default in {"21:9", "16:9", "4:3", "3:4", "1:1", "9:16"} else "9:16"
    return max(matches, default=(-1, fallback))[1]


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


def _director_messages_for_current_production(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep current-task dialogue while dropping completed production history."""
    boundary = -1
    for index, message in enumerate(messages):
        if (
            message.get("role") == "assistant"
            and message.get("kind") == "delivery"
        ):
            boundary = index
    return _director_messages_without_voice_id_directives(messages[boundary + 1:])


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


def _explicit_asset_role_overrides(
    instruction: str,
    assets: list[dict[str, Any]],
) -> dict[str, str]:
    """Honor explicit attachment roles even when the director drifts.

    This is deliberately narrow: only numbered references and an explicit
    "other images are editing material" instruction are normalized here.
    Creative placement remains owned by the director.
    """
    text = re.sub(r"\s+", "", str(instruction or ""))
    overrides: dict[str, str] = {}
    if not text:
        return overrides
    for asset in assets:
        label = re.sub(r"\s+", "", str(asset.get("label") or ""))
        if not label:
            continue
        clauses = [
            clause
            for clause in re.split(r"[，,。；;！!？?\n]+", text)
            if label in clause
        ]
        if any(re.search(r"参考|作为.*(?:生成|视频).*参考", clause) for clause in clauses):
            overrides[label] = "reference"
        if any(re.search(r"剪辑素材|作为.*素材|放到.*合适", clause) for clause in clauses):
            overrides[label] = "material"
    if re.search(r"(?:其他|其余|剩下|余下)(?:的)?(?:图片|图).*?(?:剪辑素材|作为素材|放到合适)", text):
        explicit_references = {label for label, role in overrides.items() if role == "reference"}
        for asset in assets:
            if str(asset.get("media_type") or "") != "image":
                continue
            label = re.sub(r"\s+", "", str(asset.get("label") or ""))
            if label and label not in explicit_references:
                overrides[label] = "material"
    return overrides


_LOGO_ASSET_MARKERS = ("logo", "标志", "徽标", "角标", "水印", "icon")
_IDENTITY_ASSET_MARKERS = (
    "ip形象", "ip角色", "角色设定", "角色三视图", "人物设定", "人设",
    "品牌角色", "品牌形象", "主角", "产品外观", "产品主体",
)


def _is_logo_asset(asset: dict[str, Any]) -> bool:
    return str(asset.get("media_type") or "") == "image" and any(
        marker in str(asset.get("name") or "").lower()
        for marker in _LOGO_ASSET_MARKERS
    )


def _is_identity_reference_asset(asset: dict[str, Any]) -> bool:
    """Recognize visual identity references that must survive every relevant shot."""
    if str(asset.get("media_type") or "") != "image":
        return False
    if _is_logo_asset(asset):
        return True
    text = " ".join(
        str(asset.get(key) or "")
        for key in ("name", "label", "reason", "visual_summary", "description")
    ).lower()
    return any(marker in text for marker in _IDENTITY_ASSET_MARKERS) or bool(
        re.search(r"(?:^|[\s_\-])ip(?:$|[\s_\-])", text)
    )


def _explicit_logo_overlay_labels(instruction: str, assets: list[dict[str, Any]]) -> set[str]:
    """Return only logos the user explicitly requested as a corner/watermark.

    A filename containing `logo` is not itself an instruction to turn it into a
    permanent corner bug.  The director may instead use it as a full-frame
    brand reveal or as generation reference at the narration's brand mention.
    """
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


def _apply_asset_plan(
    plan: dict[str, Any],
    assets: list[dict[str, Any]],
    instruction: str = "",
) -> str:
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
    explicit_roles = _explicit_asset_role_overrides(instruction, assets)
    explicit_logo_overlays = _explicit_logo_overlay_labels(instruction, assets)
    instruction_compact = re.sub(r"\s+", "", str(instruction or "")).lower()
    all_references_global = bool(
        re.search(r"(?:所有|全部|每个|每一).{0,10}(?:镜头|分镜).{0,12}(?:参考|使用|带入)", instruction_compact)
        or re.search(r"(?:参考图|附件).{0,10}(?:贯穿|全片|所有镜头|每个镜头)", instruction_compact)
    )

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
        # Missing director output must not silently turn every uploaded image
        # into a generation reference. Explicit user instructions are applied
        # below, while otherwise the director owns whether an image is useful
        # and which logical scene should receive it.
        default_role = "unused" if media_type == "image" else "material" if media_type == "video" else "narration"
        label = re.sub(r"\s+", "", str(asset.get("label") or ""))
        role = explicit_roles.get(label) or str(assignment.get("role") or default_role)
        allowed_roles = {
            "image": {"reference", "material", "both", "unused"},
            "video": {"material", "unused"},
            "audio": {"narration", "bgm", "sfx", "unused"},
        }.get(media_type, {"unused"})
        if role not in allowed_roles:
            role = default_role
        identity_reference = _is_identity_reference_asset(asset)
        if media_type == "image" and identity_reference and label not in explicit_roles:
            if role == "material":
                role = "both"
            elif role == "unused":
                role = "reference"
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
        if identity_reference or (role in {"reference", "both"} and all_references_global):
            merged["reference_scope"] = "global_identity"
        is_logo = _is_logo_asset(asset)
        if is_logo and label in explicit_logo_overlays:
            merged["presentation"] = "overlay"
            merged["position"] = (
                merged["position"]
                if merged["position"] in {"top-left", "top-right", "bottom-left", "bottom-right"}
                else "top-right"
            )
            merged["scale"] = min(0.3, max(0.14, safe_number(assignment.get("scale"), 0.22)))
        elif merged["presentation"] not in {"overlay", "pip", "cutaway"}:
            # A screenshot/clip that contributes evidence should normally be
            # seen at the semantic anchor, not shrunk into a generic corner.
            merged["presentation"] = "cutaway"
        normalized.append(merged)
        summary_parts.append(f"{asset.get('label')}：{role_labels[role]}")
        if role in {"reference", "both"} and str(asset.get("mime") or "").startswith("image/"):
            # Keep the director-selected logical scene on the reference.  The
            # pipeline will attach it only to render units derived from that
            # scene instead of forcing the same image onto every shot.
            reference_images.append({
                key: merged[key]
                for key in (
                    "asset_id", "label", "name", "mime", "url",
                    "scene_number", "narration_anchor", "reason", "reference_scope",
                )
                if key in merged
            })
        if role in {"material", "both"} and media_type in {"image", "video"}:
            material_assets.append(merged)
        if role == "narration" and media_type == "audio" and not narration_assets:
            narration_assets.append(merged)
        if role == "bgm" and media_type == "audio":
            bgm_assets.append(merged)
        if role == "sfx" and media_type == "audio":
            sfx_assets.append(merged)
    plan["asset_assignments"] = normalized
    reference_images.sort(key=lambda item: item.get("reference_scope") != "global_identity")
    plan["reference_images"] = reference_images[:3]
    identity_labels = [
        str(item.get("label") or item.get("name") or "")
        for item in plan["reference_images"]
        if item.get("reference_scope") == "global_identity"
    ]
    if identity_labels:
        identity_note = (
            "全片身份参考必须保持一致并在所有涉及该主体或品牌的镜头中使用："
            + "、".join(filter(None, identity_labels))
            + "。不得自行替换角色造型、Logo、产品外观或品牌识别特征。"
        )
        for scene in plan.get("scenes") or []:
            if not isinstance(scene, dict):
                continue
            visual_prompt = str(scene.get("visual_prompt") or "")
            if identity_note not in visual_prompt:
                scene["visual_prompt"] = f"{visual_prompt}\n{identity_note}".strip()
    plan["material_assets"] = material_assets
    plan["narration_audio"] = narration_assets[0] if narration_assets else None
    plan["bgm_assets"] = bgm_assets
    plan["sfx_assets"] = sfx_assets
    if bgm_assets:
        plan.setdefault("audio_design", {})["bgm_enabled"] = True
    return "；".join(summary_parts)


def _apply_static_reference_plan(
    plan: dict[str, Any],
    assets: list[dict[str, Any]],
) -> str:
    """Carry every current-turn image into each request and ensure visible use."""
    image_assets = [
        {
            key: item[key]
            for key in ("asset_id", "label", "name", "mime", "url")
            if key in item
        }
        for item in assets
        if str(item.get("media_type") or "") == "image"
        and str(item.get("mime") or "").startswith("image/")
    ][:8]
    image_ids = {str(item.get("asset_id") or "") for item in image_assets}
    narration_asset = (
        plan.get("narration_audio")
        if isinstance(plan.get("narration_audio"), dict)
        else {}
    )
    narration_id = str(narration_asset.get("asset_id") or "")
    normalized: list[dict[str, Any]] = []
    for item in assets:
        media_type = str(item.get("media_type") or "")
        asset_id = str(item.get("asset_id") or "")
        role = (
            "reference"
            if asset_id in image_ids
            else "narration"
            if media_type == "audio" and narration_id and asset_id == narration_id
            else "unused"
        )
        normalized.append({
            **{key: value for key, value in item.items() if key != "visionDataUrl"},
            "role": role,
            "reason": (
                "本轮静态分镜统一生成参考"
                if role == "reference"
                else "本轮静态视频使用该音频作为口播"
                if role == "narration"
                else "静态视频不把该附件作为剪辑画面"
            ),
        })
    plan["asset_assignments"] = normalized
    plan["reference_images"] = image_assets
    plan["material_assets"] = []
    scenes = [
        item
        for item in list(plan.get("scenes") or [])
        if isinstance(item, dict)
    ]
    valid_labels = {
        str(item.get("label") or "")
        for item in image_assets
        if str(item.get("label") or "")
    }
    covered_labels: set[str] = set()
    for scene in scenes:
        labels = [
            str(label)
            for label in list(scene.get("reference_labels") or [])
            if str(label) in valid_labels
        ]
        scene["reference_labels"] = list(dict.fromkeys(labels))
        covered_labels.update(scene["reference_labels"])
    # The provider physically receives all images on every request.  This
    # second guard prevents the director from receiving them but never showing
    # one in the delivered video.  Existing semantic/timing choices win; only
    # genuinely uncovered assets are assigned a visible scene.
    if scenes:
        for index, asset in enumerate(image_assets):
            label = str(asset.get("label") or "")
            if not label or label in covered_labels:
                continue
            target_index = len(scenes) - 1 if _is_logo_asset({
                **asset,
                "media_type": "image",
            }) else min(len(scenes) - 1, index)
            target = scenes[target_index]
            target.setdefault("reference_labels", []).append(label)
            identity = str(asset.get("name") or label)
            appearance_rule = (
                f"本分镜必须清晰呈现参考图 {label}（{identity}）中的真实主体，"
                "保持身份、外形、颜色、结构与品牌特征，不得自行替换或省略。"
            )
            prompt = str(target.get("image_prompt") or target.get("visual_prompt") or "").strip()
            prompt = f"{prompt}。{appearance_rule}".strip("。")
            target["image_prompt"] = prompt
            target["visual_prompt"] = prompt
            covered_labels.add(label)
    return (
        "；".join(f"{item.get('label')}：静态分镜统一参考" for item in image_assets)
        if image_assets
        else ""
    )


_AUTO_POLICY_REWRITE_LIMIT = 2


async def _run_pipeline_with_auto_policy(
    project_id: str,
    plan: dict[str, Any],
    retry_scene_number: int | None = None,
    *,
    recompose_only: bool = False,
) -> None:
    """Run media production and recover bounded policy-review failures.

    Provider/network failures stay visible and manually retryable. Only an
    identified copyright/safety rejection is rewritten automatically, and
    only the rejected scene is regenerated.
    """
    await pipeline.run(
        project_id,
        plan,
        retry_scene_number=retry_scene_number,
        recompose_only=recompose_only,
    )
    if recompose_only:
        return
    for _ in range(_AUTO_POLICY_REWRITE_LIMIT):
        project = await asyncio.to_thread(load_project, project_id)
        if not project or project.get("status") != "failed":
            return
        retryable = _retry_info(project)
        if not retryable or retryable.get("type") != "safe_rewrite":
            return
        history = list(project.get("autoPolicyRewrites") or [])
        if len(history) >= _AUTO_POLICY_REWRITE_LIMIT:
            return
        current_plan = project.get("plan")
        if not isinstance(current_plan, dict) or not current_plan.get("scenes"):
            return
        scene_number = int(retryable.get("sceneNumber") or 0)
        if not 1 <= scene_number <= len(current_plan["scenes"]):
            return
        reason = str(retryable.get("reason") or "safety")
        is_copyright = reason == "copyright"
        await asyncio.to_thread(
            add_event,
            project_id,
            f"自动改写镜头 {scene_number}",
            "镜头未通过审核，导演正在保留叙事作用并改写后继续制作。",
            "running",
            max(18, min(58, int(project.get("progress") or 18))),
            "recovery",
        )
        try:
            with project_usage_scope(project_id):
                rewrite = await director.rewrite_scene_for_safety(
                    current_plan,
                    scene_number,
                    reason,
                )
        except ProviderError as exc:
            await asyncio.to_thread(
                add_event,
                project_id,
                "自动改写未完成",
                str(exc),
                "error",
                None,
                "error",
            )
            return
        original_prompt = str(current_plan["scenes"][scene_number - 1].get("visual_prompt") or "")
        current_plan["scenes"][scene_number - 1]["visual_prompt"] = rewrite["visual_prompt"]
        history.append(
            {
                "attempt": len(history) + 1,
                "sceneNumber": scene_number,
                "reason": reason,
                "originalPrompt": original_prompt,
                "rewrittenPrompt": rewrite["visual_prompt"],
                "changeSummary": rewrite["change_summary"],
            }
        )

        def save_rewrite(item: dict[str, Any]) -> None:
            item["plan"] = current_plan
            item["autoPolicyRewrites"] = history
            item["status"] = "running"
            item["phase"] = "production"
            item["error"] = ""
            item["retryable"] = None

        await asyncio.to_thread(mutate_project, project_id, save_rewrite)
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            f"镜头 {scene_number} 未通过审核，已自动完成{'原创' if is_copyright else '安全'}改写并继续制作，无需手动确认。",
            kind="retry",
        )
        await pipeline.run(project_id, current_plan, retry_scene_number=scene_number)


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


async def _transcribe_candidate(
    project_id: str,
    message: str,
    current_assets: list[dict[str, Any]],
) -> str:
    candidate = _narration_candidate(message, current_assets)
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
    candidate["transcript"] = result

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
        "contractVersion": VIDEO_WORKSHOP_CONTRACT_VERSION,
        "buildId": VIDEO_WORKSHOP_BUILD_ID,
        "readOnly": _runtime_read_only(),
        "writePolicy": "deny-mutations" if _runtime_read_only() else "normal",
        "live": settings.live,
        "ready": not missing_required,
        "status": status,
        "missingRequired": missing_required,
        "optionalUnavailable": optional_unavailable,
        "services": services,
    }


@app.get("/api/projects")
async def project_list(
    page: Optional[int] = None,
    pageSize: Optional[int] = None,
    projectIds: str = "",
):
    requested_ids = {
        project_id.strip()
        for project_id in str(projectIds or "").split(",")
        if project_id.strip()
    }
    project_filter = requested_ids if projectIds else None
    items = await asyncio.to_thread(list_project_summaries, project_filter)
    if not _runtime_read_only():
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
            items = await asyncio.to_thread(list_project_summaries, project_filter)
    total = len(items)
    if page is None and pageSize is None:
        # Backward compatibility for older standalone clients.
        return {"items": items, "total": total}
    current_page = max(1, int(page or 1))
    page_size = max(1, min(100, int(pageSize or 60)))
    start = (current_page - 1) * page_size
    return {
        "items": items[start:start + page_size],
        "total": total,
        "page": current_page,
        "pageSize": page_size,
        "hasMore": start + page_size < total,
    }


@app.post("/api/projects")
async def project_create():
    """Create a durable empty conversation before its first message.

    The client uses this endpoint when the user presses “new conversation” so
    the history entry is immediately real, not a temporary row that only
    appears after the first director request finishes.
    """
    project = await asyncio.to_thread(create_project)
    return _project_response(project)


@app.get("/api/projects/{project_id}")
async def project_detail(project_id: str):
    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    if not _runtime_read_only():
        if (
            project.get("status") == "running"
            and not _project_has_active_work(project_id)
        ):
            project = await asyncio.to_thread(
                _mark_orphaned_running_project,
                project_id,
            )
        project = await _auto_resume_restart_project(project_id, project)
    return _project_response(project)


@app.post("/api/projects/{project_id}/assets")
async def project_asset_upload(project_id: str, req: ProjectAssetUploadRequest):
    """Import editor material without starting the director or media pipeline."""

    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    decoded = await asyncio.to_thread(_decode_attachments, req.attachments)
    if not decoded:
        raise HTTPException(400, "没有可导入的图片、视频或音频")
    saved = await asyncio.to_thread(_save_attachments, project_id, decoded)
    saved = await _enrich_saved_attachments(project_id, saved)

    def append_assets(item: dict[str, Any]) -> None:
        item["assets"] = [*(item.get("assets") or []), *saved]

    updated = await asyncio.to_thread(mutate_project, project_id, append_assets)
    return {"ok": True, "items": saved, "project": _project_response(updated)}


def _find_project_output(project: dict[str, Any], output_id: str) -> dict[str, Any] | None:
    rows: list[dict[str, Any]] = []
    rows.extend(item for item in project.get("outputs") or [] if isinstance(item, dict))
    for delivery in project.get("deliveries") or []:
        if isinstance(delivery, dict):
            rows.extend(
                item for item in delivery.get("outputs") or [] if isinstance(item, dict)
            )
    return next(
        (item for item in rows if str(item.get("id") or "") == str(output_id or "")),
        None,
    )


def _video_editor_state(
    project: dict[str, Any],
    output_id: str,
) -> dict[str, Any]:
    project_id = str(project.get("id") or "")
    output = _find_project_output(project, output_id)
    if output is None:
        raise HTTPException(404, "成片不存在")
    work_dir = settings.outputs_dir / project_id
    composition_file = Path(str(output.get("compositionFile") or "composition.json")).name
    composition_path = work_dir / composition_file
    if not composition_path.is_file() and composition_file != "composition.json":
        composition_path = work_dir / "composition.json"
    if not composition_path.is_file():
        raise HTTPException(409, "当前成片缺少可编辑的时间线快照")
    try:
        composition = json.loads(composition_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(409, f"成片时间线不可读取：{exc}")
    scenes = [
        item for item in list((project.get("plan") or {}).get("scenes") or [])
        if isinstance(item, dict)
    ]
    timeline_edit = (
        project.get("plan", {}).get("timeline_edit")
        if isinstance(project.get("plan"), dict)
        else {}
    )
    saved_clips = [
        item for item in list((timeline_edit or {}).get("clips") or [])
        if isinstance(item, dict)
    ]
    clips = []
    for index, cut in enumerate(composition.get("cuts") or [], start=1):
        if not isinstance(cut, dict):
            continue
        source = Path(str(cut.get("source") or ""))
        if not source.is_file():
            continue
        director_number = max(1, int(cut.get("directorSceneNumber") or index))
        scene = scenes[director_number - 1] if director_number <= len(scenes) else {}
        saved_clip = saved_clips[index - 1] if index <= len(saved_clips) else {}
        start = float(cut.get("in_seconds") or 0)
        end = float(cut.get("out_seconds") or start + 1)
        clips.append(
            {
                "id": f"clip-{index}-{uuid.uuid4().hex[:8]}",
                "sourceFile": source.name,
                "sourceSceneNumber": director_number,
                "segmentNumber": max(1, int(cut.get("segmentNumber") or 1)),
                "segmentCount": max(1, int(cut.get("segmentCount") or 1)),
                "title": str(scene.get("title") or f"镜头 {director_number}"),
                "subtitle": str(
                    saved_clip.get("subtitle")
                    if "subtitle" in saved_clip
                    else (
                        scene.get("narration_excerpt")
                        or scene.get("title")
                        or f"镜头 {director_number}"
                    )
                ).strip()[:1200],
                "purpose": str(
                    scene.get("purpose")
                    or scene.get("visual_prompt")
                    or "成片镜头"
                )[:160],
                "duration": round(max(0.25, end - start), 3),
                "trimStart": max(0.0, float(cut.get("trimStart") or 0)),
                "replacementAssetId": str(saved_clip.get("replacement_asset_id") or ""),
                "transition": str(saved_clip.get("transition") or "fade"),
            }
        )
    if not clips:
        raise HTTPException(409, "当前成片没有可编辑的镜头源文件")
    audio_design = (
        dict(project.get("plan", {}).get("audio_design") or {})
        if isinstance(project.get("plan"), dict)
        else {}
    )
    assets = []
    audio_assets = []
    for asset in project.get("assets") or []:
        if not isinstance(asset, dict):
            continue
        asset_id = str(asset.get("id") or asset.get("asset_id") or asset.get("url") or asset.get("name") or "")
        if not asset_id:
            continue
        public_asset = {
            "id": asset_id,
            "label": str(asset.get("label") or asset.get("name") or "未命名素材"),
            "name": str(asset.get("name") or asset.get("label") or "未命名素材"),
            "mime": str(asset.get("mime") or ""),
            "url": str(asset.get("url") or ""),
            "duration": max(0.1, float(asset.get("duration") or 0.6)),
        }
        if public_asset["mime"].startswith("audio/"):
            audio_assets.append(public_asset)
        else:
            assets.append(public_asset)
    return {
        "output": output,
        "clips": clips,
        "assets": assets,
        "audioAssets": audio_assets,
        "bgmCatalog": bgm_library.catalog(),
        "soundEffectCatalog": sfx_library.catalog(),
        "currentBgm": output.get("bgm") or None,
        "bgmSelection": str((timeline_edit or {}).get("bgm_selection") or "keep"),
        "narrationVolume": float(audio_design.get("narration_volume", 1.0)),
        "bgmVolume": float(audio_design.get("bgm_volume", 0.12)),
        "soundEffects": list((timeline_edit or {}).get("sound_effects") or []),
        "overlays": list((timeline_edit or {}).get("overlays") or []),
        "subtitleEffect": str((timeline_edit or {}).get("subtitle_effect") or ""),
        "compositionFile": composition_path.name,
    }


@app.get("/api/projects/{project_id}/video-editor")
async def project_video_editor(project_id: str, outputId: str):
    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    return {"ok": True, **_video_editor_state(project, outputId)}


@app.post("/api/projects/{project_id}/timeline-revision")
async def project_timeline_revision(project_id: str, req: TimelineRevisionRequest):
    project = await asyncio.to_thread(load_project, project_id)
    if project is None:
        raise HTTPException(404, "项目不存在")
    if _project_has_active_work(project_id):
        raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
    if project.get("status") != "succeeded":
        raise HTTPException(409, "请等待当前成片完成后再进入剪辑台")
    editor_state = _video_editor_state(project, req.outputId)
    allowed_sources = {str(item["sourceFile"]) for item in editor_state["clips"]}
    assets_by_id = {str(item["id"]): item for item in editor_state["assets"]}
    audio_assets_by_id = {str(item["id"]): item for item in editor_state["audioAssets"]}
    project_assets_by_id = {
        str(item.get("id") or item.get("asset_id") or item.get("url") or item.get("name") or ""): item
        for item in project.get("assets") or []
        if isinstance(item, dict)
    }
    bgm_catalog_by_id = {str(item.get("id") or ""): item for item in editor_state["bgmCatalog"]}
    sfx_catalog_by_id = {str(item.get("id") or ""): item for item in editor_state["soundEffectCatalog"]}
    valid_transitions = {"fade", "dissolve", "slideleft", "wipeleft", "circleopen"}
    clips = []
    for item in req.clips:
        source_file = Path(item.sourceFile).name
        if source_file != item.sourceFile or source_file not in allowed_sources:
            raise HTTPException(400, "剪辑台包含不属于当前成片的镜头")
        if item.replacementAssetId and item.replacementAssetId not in assets_by_id:
            raise HTTPException(400, "剪辑台替换素材不属于当前项目")
        clips.append(
            {
                "id": item.id,
                "source_file": source_file,
                "source_scene_number": item.sourceSceneNumber,
                "segment_number": item.segmentNumber,
                "segment_count": item.segmentCount,
                "duration": round(item.duration, 3),
                "trim_start": round(item.trimStart, 3),
                "subtitle": item.subtitle.strip()[:1200],
                "replacement_asset_id": item.replacementAssetId,
                "transition": item.transition if item.transition in valid_transitions else "fade",
            }
        )
    valid_positions = {"top-left", "top-right", "bottom-left", "bottom-right", "center", "custom"}
    valid_overlay_effects = {"none", "fade", "slide-left", "slide-up"}
    overlays = []
    editor_materials = []
    for item in req.overlays:
        asset = assets_by_id.get(item.assetId)
        if asset is None:
            raise HTTPException(400, "画中画素材不属于当前项目")
        position = item.position if item.position in valid_positions else "top-right"
        overlay = {
            "asset_id": item.assetId,
            "start": round(item.start, 3),
            "duration": round(item.duration, 3),
            "position": position,
            "position_x": round(item.positionX, 6),
            "position_y": round(item.positionY, 6),
            "scale": round(item.scale, 3),
            "entry_effect": item.entryEffect if item.entryEffect in valid_overlay_effects else "fade",
            "exit_effect": item.exitEffect if item.exitEffect in valid_overlay_effects else "fade",
        }
        overlays.append(overlay)
        editor_materials.append(
            {
                "asset_id": item.assetId,
                "label": asset["label"],
                "name": asset["name"],
                "mime": asset["mime"],
                "url": asset["url"],
                "scene_number": 1,
                "start_sec": overlay["start"],
                "duration_sec": overlay["duration"],
                "presentation": "pip",
                "position": position,
                "position_x": overlay["position_x"],
                "position_y": overlay["position_y"],
                "scale": overlay["scale"],
                "entry_effect": overlay["entry_effect"],
                "exit_effect": overlay["exit_effect"],
                "editor_origin": True,
            }
        )
    sound_effects = []
    editor_sfx_assets = []
    for item in req.soundEffects:
        source_type = item.sourceType if item.sourceType in {"catalog", "asset"} else ""
        source_id = item.sourceId.strip()
        if source_type == "catalog":
            catalog_item = sfx_catalog_by_id.get(source_id)
            if catalog_item is None or sfx_library.resolve(source_id) is None:
                raise HTTPException(400, "选中的平台音效不可用")
            source_asset = {
                "builtin_sfx_id": source_id,
                "label": str(catalog_item.get("name") or item.label or "平台音效"),
                "name": str(catalog_item.get("name") or item.label or "平台音效"),
                "mime": "audio/ogg",
                "url": str(catalog_item.get("url") or ""),
                "license": str(catalog_item.get("license") or "CC0 1.0"),
            }
        elif source_type == "asset":
            if source_id not in audio_assets_by_id or source_id not in project_assets_by_id:
                raise HTTPException(400, "选中的音效音频不属于当前项目")
            source_asset = dict(project_assets_by_id[source_id])
        else:
            raise HTTPException(400, "音效来源无效")
        normalized = {
            "id": item.id,
            "source_type": source_type,
            "source_id": source_id,
            "label": str(source_asset.get("label") or source_asset.get("name") or item.label or "音效")[:180],
            "start": round(item.start, 3),
            "duration": round(item.duration, 3),
            "volume": round(item.volume, 3),
        }
        sound_effects.append(normalized)
        editor_sfx_assets.append({
            **source_asset,
            "asset_id": str(source_asset.get("asset_id") or source_id),
            "scene_number": 1,
            "start_sec": normalized["start"],
            "duration_sec": normalized["duration"],
            "volume": normalized["volume"],
            "editor_origin": True,
        })
    subtitle_styles = {
        "逐字高亮": {"animation": "word-highlight", "public_summary": "逐字高亮"},
        "简洁淡入": {"animation": "fade", "public_summary": "简洁淡入"},
        "关键词放大": {"animation": "keyword-pop", "public_summary": "关键词放大"},
        "去掉字幕": {"enabled": False, "public_summary": "去掉字幕"},
    }
    edit_id = uuid.uuid4().hex[:16]
    plan = dict(project.get("plan") or {})
    bgm_selection = req.bgmSelection.strip() or "keep"
    audio_design = dict(plan.get("audio_design") or {})
    audio_design["narration_volume"] = round(req.narrationVolume, 3)
    audio_design["bgm_volume"] = round(req.bgmVolume, 3)
    if bgm_selection == "none":
        audio_design["bgm_enabled"] = False
        audio_design.pop("bgm_track_id", None)
        plan["bgm_assets"] = []
    elif bgm_selection.startswith("catalog:"):
        track_id = bgm_selection.removeprefix("catalog:")
        if track_id not in bgm_catalog_by_id:
            raise HTTPException(400, "选中的 BGM 不属于当前可用配乐库")
        audio_design["bgm_enabled"] = True
        audio_design["bgm_track_id"] = track_id
        plan["bgm_assets"] = []
    elif bgm_selection.startswith("asset:"):
        asset_id = bgm_selection.removeprefix("asset:")
        if asset_id not in audio_assets_by_id or asset_id not in project_assets_by_id:
            raise HTTPException(400, "选中的 BGM 音频不属于当前项目")
        audio_design["bgm_enabled"] = True
        audio_design.pop("bgm_track_id", None)
        plan["bgm_assets"] = [dict(project_assets_by_id[asset_id])]
    elif bgm_selection == "keep":
        current_bgm = editor_state.get("currentBgm")
        if not current_bgm:
            audio_design["bgm_enabled"] = False
            audio_design.pop("bgm_track_id", None)
            plan["bgm_assets"] = []
        else:
            current_track_id = str(current_bgm.get("id") or "")
            if current_track_id in bgm_catalog_by_id:
                audio_design["bgm_enabled"] = True
                audio_design["bgm_track_id"] = current_track_id
                plan["bgm_assets"] = []
    elif bgm_selection != "keep":
        raise HTTPException(400, "BGM 选择无效")
    plan["audio_design"] = audio_design
    plan["timeline_edit"] = {
        "id": edit_id,
        "base_output_id": req.outputId,
        "clips": clips,
        "overlays": overlays,
        "sound_effects": sound_effects,
        "bgm_selection": bgm_selection,
        "subtitle_effect": req.subtitleEffect,
    }
    original_materials = [
        item for item in list(plan.get("material_assets") or [])
        if isinstance(item, dict) and not item.get("editor_origin")
    ]
    plan["material_assets"] = [*original_materials, *editor_materials]
    original_sfx_assets = [
        item for item in list(plan.get("sfx_assets") or [])
        if isinstance(item, dict) and not item.get("editor_origin")
    ]
    plan["sfx_assets"] = [*original_sfx_assets, *editor_sfx_assets]
    if req.subtitleEffect:
        plan["subtitle_style"] = subtitle_styles.get(
            req.subtitleEffect,
            plan.get("subtitle_style") or {},
        )

    revision_record = {
        "id": edit_id,
        "type": "manual_timeline",
        "baseOutputId": req.outputId,
        "clipCount": len(clips),
        "overlayCount": len(overlays),
        "soundEffectCount": len(sound_effects),
        "subtitleEffect": req.subtitleEffect,
    }

    def mark_revision(item: dict[str, Any]) -> None:
        history = [row for row in item.get("revisionHistory") or [] if isinstance(row, dict)]
        item["revisionHistory"] = [revision_record, *history][:50]
        item["plan"] = plan
        item["status"] = "running"
        item["phase"] = "production"
        item["progress"] = 18
        item["error"] = ""
        item["retryable"] = None

    with _launching_project(project_id):
        await asyncio.to_thread(mutate_project, project_id, mark_revision)
        await asyncio.to_thread(
            add_event,
            project_id,
            "手动剪辑时间线已锁定",
            f"已保存 {len(clips)} 个主轨片段和 {len(overlays)} 个画中画片段，正在复用原素材合成新版。",
            "running",
            18,
            "production",
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            "剪辑台修改已保存。原成片继续保留，本次不重新调用画面或口播生成，只重新剪辑、合成和质检。",
            kind="plan",
        )
        if not _schedule(project_id, plan, recompose_only=True):
            raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
    return {"ok": True, "project": _project_response(await asyncio.to_thread(load_project, project_id))}


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


@app.post("/api/projects/{project_id}/speed-version")
async def project_speed_version(project_id: str, req: SpeedVersionRequest):
    if _project_has_active_work(project_id):
        raise HTTPException(409, "当前项目仍在制作，请等待完成后再调整速度")
    try:
        output = await pipeline.create_speed_version(project_id, req.outputId, req.speed)
    except KeyError:
        raise HTTPException(404, "项目不存在")
    except (MediaError, RuntimeError, ValueError) as exc:
        raise HTTPException(400, str(exc))
    return {"ok": True, "output": output}


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
    if not retryable:
        raise HTTPException(409, "当前失败不支持安全改写重试")
    plan = project.get("plan")
    if not isinstance(plan, dict) or not plan.get("scenes"):
        raise HTTPException(409, "导演计划不完整，无法恢复")

    scene_number = int(retryable["sceneNumber"])
    previous_error = _latest_actionable_failure(project)
    previous_progress = int(project.get("progress") or 0)
    is_copyright_rewrite = retryable.get("reason") == "copyright"

    if retryable.get("type") in {"resume_missing", "resume_plan"}:
        resume_from_plan = retryable.get("type") == "resume_plan"
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
                f"正在从镜头 {scene_number} 继续原任务",
                (
                    "已保留原导演计划，将沿用同一任务继续口播、图片或视频镜头。"
                    if resume_from_plan
                    else "已保留完成的口播与媒体素材，将继续所有缺失镜头。"
                ),
                "running",
                max(12, min(58, previous_progress)),
                "recovery",
            )
            await asyncio.to_thread(
                add_message,
                project_id,
                "assistant",
                f"已继续原制作任务。本次从镜头 {scene_number} 接着执行，"
                "不会重新做一份导演方案；已经完成的本地素材会直接复用。",
                kind="retry",
            )
            if not _schedule(project_id, plan, retry_scene_number=scene_number):
                raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
            return _project_response(await asyncio.to_thread(load_project, project_id))

    if retryable.get("type") == "recompose":
        with _launching_project(project_id):
            def mark_recomposing(item: dict[str, Any]) -> None:
                item["status"] = "running"
                item["phase"] = "recovery"
                item["progress"] = max(72, min(94, previous_progress))
                item["error"] = ""
                item["retryable"] = None

            await asyncio.to_thread(mutate_project, project_id, mark_recomposing)
            await asyncio.to_thread(
                add_event,
                project_id,
                "正在继续合成成片",
                "保留现有口播和全部镜头，只重新执行字幕、合成与成片检查。",
                "running",
                max(72, min(94, previous_progress)),
                "recovery",
            )
            await asyncio.to_thread(
                add_message,
                project_id,
                "assistant",
                "已继续实际制作任务：现有口播和镜头全部保留，正在重新合成并检查成片。",
                kind="retry",
            )
            if not _schedule(project_id, plan, recompose_only=True):
                raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
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
            with project_usage_scope(project_id):
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
        if not _schedule(project_id, plan, retry_scene_number=scene_number):
            raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
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
    plan = project.get("plan") if isinstance(project.get("plan"), dict) else None
    scenes = list((plan or {}).get("scenes") or [])
    if not retryable and scenes:
        work_dir = settings.outputs_dir / project_id
        first_missing = next(
            (
                scene_number
                for scene_number in range(1, len(scenes) + 1)
                if not _scene_output_exists(plan, work_dir, scene_number)
            ),
            1,
        )
        retryable = {"type": "resume_plan", "sceneNumber": first_missing}
    resumable = bool(
        retryable
        and retryable.get("type") in {"resume_missing", "resume_plan"}
    )
    scene_number = int((retryable or {}).get("sceneNumber") or 0)
    message = (
        "制作已按请求停止。已经完成的口播和镜头文件会保留，"
        f"稍后可从缺失镜头 {scene_number} 继续。"
        if resumable
        else (
            "制作已按请求停止。已完成的本地文件会保留；"
            "当前还没有形成可恢复的导演计划，可以继续聊天后再开始制作。"
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


async def _handle_local_revision(
    project: dict[str, Any],
    message: str,
    current_assets: list[dict[str, Any]],
) -> dict[str, Any] | None:
    plan = project.get("plan") if isinstance(project.get("plan"), dict) else None
    revision = _local_revision_request(message, plan, current_assets)
    if not revision or plan is None:
        return None

    project_id = str(project.get("id") or "")
    revision_type = str(revision.get("type") or "")
    if revision_type == "invalid_scene":
        scene_count = int(revision.get("sceneCount") or 0)
        reply = f"当前只有 {scene_count} 个镜头，请告诉我要修改镜头 1 到镜头 {scene_count} 中的哪一个。"
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            reply,
            kind="question",
        )
        return await asyncio.to_thread(load_project, project_id)
    if revision_type == "timeline_change":
        reply = (
            "这项修改会改变口播或总时长，不能只替换一个镜头，否则音画会错位。"
            "请确认要重新规划整条音画时间线；原成片会继续保留在历史成片中。"
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            reply,
            kind="question",
            suggestions=["确认重新规划整条视频", "只调整这个镜头画面", "保持口播和时长不变"],
        )
        return await asyncio.to_thread(load_project, project_id)
    if revision_type == "subtitle_text":
        reply = (
            "字幕文字必须与原口播一致。如果这是识别、错字或漏字问题，可以让字幕恢复为原口播，"
            "复用原音画重新合成；若要采用新的字幕文字，则需要同步修改并重做口播。"
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            reply,
            kind="question",
            suggestions=["让字幕恢复为原口播并重新合成", "确认同步修改并重做口播", "保持字幕内容不变"],
        )
        return await asyncio.to_thread(load_project, project_id)

    scenes = [item for item in list(plan.get("scenes") or []) if isinstance(item, dict)]
    work_dir = settings.outputs_dir / project_id
    required_sources = [work_dir / "narration.mp3"]
    if revision_type == "scene":
        requested_number = int(revision.get("sceneNumber") or 0)
        for index in range(1, len(scenes) + 1):
            if index != requested_number:
                required_sources.extend(_scene_output_paths(plan, work_dir, index))
    else:
        for index in range(1, len(scenes) + 1):
            required_sources.extend(_scene_output_paths(plan, work_dir, index))
    missing_logical_scenes = [
        index
        for index in range(1, len(scenes) + 1)
        if (revision_type != "scene" or index != int(revision.get("sceneNumber") or 0))
        and not _scene_output_exists(plan, work_dir, index)
    ]
    missing_sources = [path.name for path in required_sources if not path.is_file()]
    missing_sources.extend(f"镜头 {index}" for index in missing_logical_scenes)
    if missing_sources:
        reply = (
            "原成片的音画源文件不完整，不能安全执行局部修改，否则会意外重做口播或其他镜头。"
            "请先恢复原素材，或确认重新制作完整视频。缺少："
            + "、".join(missing_sources[:8])
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            reply,
            kind="question",
            suggestions=["重新制作完整视频", "保持现有成片不变"],
        )
        return await asyncio.to_thread(load_project, project_id)

    try:
        if revision_type == "scene":
            scene_number = int(revision["sceneNumber"])
            with project_usage_scope(project_id):
                rewrite = await director.revise_scene(
                    plan,
                    scene_number,
                    str(revision.get("instruction") or ""),
                )
            scenes = [dict(item) for item in scenes]
            original_prompt = str(scenes[scene_number - 1].get("visual_prompt") or "")
            scenes[scene_number - 1]["visual_prompt"] = rewrite["visual_prompt"]
            if rewrite.get("title"):
                scenes[scene_number - 1]["title"] = rewrite["title"]
            if rewrite.get("purpose"):
                scenes[scene_number - 1]["purpose"] = rewrite["purpose"]
            revised_plan = {**plan, "scenes": scenes}
            revision_record = {
                "id": uuid.uuid4().hex[:16],
                "type": "scene",
                "sceneNumber": scene_number,
                "instruction": str(revision.get("instruction") or "")[:1000],
                "originalPrompt": original_prompt,
                "revisedPrompt": rewrite["visual_prompt"],
                "summary": str(rewrite.get("change_summary") or "")[:300],
            }
            assistant_text = (
                f"已按你的意见改写镜头 {scene_number}。本次只重新生成这一段，"
                "其余镜头、原口播和配乐会继续复用；旧成片仍保留在历史成片中。"
            )
            event_title = f"镜头 {scene_number} 局部修订已锁定"
            event_detail = str(rewrite.get("change_summary") or assistant_text)
            retry_scene_number = scene_number
            recompose_only = False
        elif revision_type == "motion_recompose":
            revised_plan = dict(plan)
            revision_record = {
                "id": uuid.uuid4().hex[:16],
                "type": "motion_timeline",
                "instruction": str(revision.get("instruction") or "")[:1000],
            }
            assistant_text = (
                "已保留原导演方案、口播和镜头素材。本次只按口播的真实时长重新建立"
                "视频时间线，移除静止尾帧补时；旧成片仍保留在历史成片中。"
            )
            event_title = "视频时间线修订已锁定"
            event_detail = "复用原音画，按真实口播时长重新编排连续运动画面。"
            retry_scene_number = None
            recompose_only = True
        else:
            with project_usage_scope(project_id):
                subtitle_style = await director.revise_subtitle_style(
                    plan,
                    str(revision.get("instruction") or ""),
                )
            revised_plan = {**plan, "subtitle_style": subtitle_style}
            revision_record = {
                "id": uuid.uuid4().hex[:16],
                "type": "subtitles",
                "instruction": str(revision.get("instruction") or "")[:1000],
                "subtitleStyle": subtitle_style,
            }
            assistant_text = (
                "字幕编排已更新。本次不会重新生成镜头或口播，只复用原音画重新分句、"
                "排版并合成；旧成片仍保留在历史成片中。"
            )
            event_title = "字幕局部修订已锁定"
            event_detail = str(subtitle_style.get("public_summary") or assistant_text)
            retry_scene_number = None
            recompose_only = True
    except ProviderError as exc:
        await asyncio.to_thread(
            add_event,
            project_id,
            "局部修订未完成",
            str(exc),
            "error",
            None,
            "brief",
        )
        raise HTTPException(502, str(exc))

    if _project_has_active_work(project_id):
        raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
    with _launching_project(project_id):
        def mark_revision(item: dict[str, Any]) -> None:
            history = [row for row in item.get("revisionHistory") or [] if isinstance(row, dict)]
            item["revisionHistory"] = [revision_record, *history][:50]
            item["plan"] = revised_plan
            item["status"] = "running"
            item["phase"] = "production"
            item["progress"] = 12
            item["error"] = ""
            item["retryable"] = None

        await asyncio.to_thread(mutate_project, project_id, mark_revision)
        await asyncio.to_thread(
            add_event,
            project_id,
            event_title,
            event_detail,
            "running",
            12,
            "production",
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            assistant_text,
            kind="plan",
        )
        if not _schedule(
            project_id,
            revised_plan,
            retry_scene_number=retry_scene_number,
            recompose_only=recompose_only,
        ):
            raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
    return await asyncio.to_thread(load_project, project_id)


async def _run_director_production(
    project_id: str,
    *,
    aspect_ratio: str,
    creation_mode: str,
    director_assets: list[dict[str, Any]],
    saved_attachments: list[dict[str, Any]],
    revision_message: str,
    original_message: str,
    selected_voice_id: str,
) -> None:
    """Finish director planning and production independently of the browser request."""
    try:
        project = await asyncio.to_thread(load_project, project_id)
        if project is None:
            return
        director_messages = _director_messages_for_current_production(
            project["messages"]
        )
        if revision_message != original_message:
            for message in reversed(director_messages):
                if message.get("role") == "user":
                    message["content"] = revision_message
                    break
        with project_usage_scope(project_id):
            decision = await director.decide(
                director_messages,
                aspect_ratio,
                director_assets,
                skill_context=director_context(),
                bgm_catalog=bgm_library.catalog(),
                creation_mode=creation_mode,
            )
        if decision["action"] == "ask":
            question = str(decision.get("question") or "").strip()
            await asyncio.to_thread(
                add_message,
                project_id,
                "assistant",
                question,
                kind="question",
                suggestions=decision.get("suggestions") or [],
            )
            await asyncio.to_thread(
                add_event,
                project_id,
                "等待补充关键信息",
                "导演只保留了一个会显著影响成片的问题。",
                "waiting",
                6,
                "brief",
            )

            def mark_waiting(item: dict[str, Any]) -> None:
                item["status"] = "conversation"
                item["phase"] = "brief"
                item["progress"] = 6
                item["error"] = ""

            await asyncio.to_thread(mutate_project, project_id, mark_waiting)
            return

        plan = decision["plan"]
        plan["creation_mode"] = creation_mode
        plan["skill"] = SKILL_NAME
        plan["voice_id"] = selected_voice_id
        # One conversation can produce several unrelated videos.  Give every
        # accepted production plan its own durable scope so pipeline-generated
        # continuity references can be reused by retries of this production,
        # but can never leak into the next production in the same project.
        plan["reference_scope_id"] = uuid.uuid4().hex
        asset_summary = _apply_asset_plan(plan, saved_attachments, original_message)
        if creation_mode == "static":
            asset_summary = _apply_static_reference_plan(plan, saved_attachments)
        narration_asset = plan.get("narration_audio") or {}
        transcript_text = str((narration_asset.get("transcript") or {}).get("text") or "").strip()
        if transcript_text:
            plan["narration"] = transcript_text
            plan["input_mode"] = "audio"
        if asset_summary:
            await asyncio.to_thread(
                add_event,
                project_id,
                "附件用途已确认",
                asset_summary,
                "running",
                8,
                "brief",
            )

        def mark_running(item: dict[str, Any]) -> None:
            item["status"] = "running"
            item["phase"] = "production"
            item["progress"] = 10
            item["plan"] = plan
            item["error"] = ""

        await asyncio.to_thread(mutate_project, project_id, mark_running)
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            f"信息够了。我会用“{plan['title']}”这个方向制作：{plan.get('director_note') or '镜头结构和节奏将按口播内容展开。'}",
            kind="plan",
        )
        # Stay in the same detached server task for the whole lifecycle. A tab
        # switch or iframe unmount can no longer interrupt planning or prevent
        # the already accepted plan from entering the media pipeline.
        await _run_pipeline_with_auto_policy(project_id, plan)
    except asyncio.CancelledError:
        raise
    except ProviderError as exc:
        detail = str(exc)
        await asyncio.to_thread(
            add_event,
            project_id,
            "导演连接失败",
            detail,
            "error",
            None,
            "brief",
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            f"导演请求没有完成：{detail}。你可以直接重试，已上传附件和本轮消息均已保留。",
            kind="error",
        )

        def mark_retryable(item: dict[str, Any]) -> None:
            item["status"] = "conversation"
            item["phase"] = "brief"
            item["progress"] = 4
            item["error"] = ""

        await asyncio.to_thread(mutate_project, project_id, mark_retryable)
    except Exception as exc:
        detail = f"{exc.__class__.__name__}: {str(exc).strip() or '未知异常'}"
        await asyncio.to_thread(
            add_event,
            project_id,
            "导演任务异常",
            detail,
            "error",
            None,
            "brief",
        )
        await asyncio.to_thread(
            add_message,
            project_id,
            "assistant",
            "导演任务没有完成，已保留本轮消息和附件。你可以直接重试。",
            kind="error",
        )

        def mark_unexpected_retryable(item: dict[str, Any]) -> None:
            item["status"] = "conversation"
            item["phase"] = "brief"
            item["progress"] = 4
            item["error"] = ""

        await asyncio.to_thread(
            mutate_project,
            project_id,
            mark_unexpected_retryable,
        )


@app.post("/api/chat")
async def chat(req: ChatRequest):
    if len(req.attachments) > _MAX_ATTACHMENTS_PER_MESSAGE:
        raise HTTPException(400, "每条消息最多添加 8 个附件")
    project = await asyncio.to_thread(load_project, req.projectId) if req.projectId else None
    if project is None:
        project = await asyncio.to_thread(create_project)
    if project.get("status") == "running":
        raise HTTPException(409, "当前项目仍在制作，请等待完成")
    if _project_has_active_work(str(project.get("id") or "")):
        raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
    creation_mode = "static" if str(req.creationMode or "").strip().lower() == "static" else "video"
    existing_plan = project.get("plan") if isinstance(project.get("plan"), dict) else {}
    previous_creation_mode = str(
        existing_plan.get("creation_mode")
        or project.get("creationMode")
        or "video"
    ).strip().lower()
    creation_mode_changed = bool(existing_plan.get("scenes")) and previous_creation_mode != creation_mode
    try:
        selected_voice_id = _selected_voice_id(req, project)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    def remember_voice(item: dict[str, Any]) -> None:
        item["voiceId"] = selected_voice_id
        item["creationMode"] = creation_mode
        if creation_mode == "static" and (
            req.billingReservationId or req.billingBypassed
        ):
            item["billing"] = {
                "reservationId": str(req.billingReservationId or ""),
                "ownerId": str(req.billingOwnerId or ""),
                "pointLimit": max(0, int(req.billingPointLimit or 0)),
                "bypassed": bool(req.billingBypassed),
                "status": "reserved",
            }
            item.pop("billingUsage", None)

    await asyncio.to_thread(mutate_project, project["id"], remember_voice)
    project["voiceId"] = selected_voice_id

    requested_ratio = str(req.aspectRatio or "").strip()
    default_ratio = requested_ratio or ("16:9" if creation_mode == "static" else "9:16")
    aspect_ratio = _infer_aspect_ratio(req.message, default=default_ratio)
    decoded_attachments = await asyncio.to_thread(_decode_attachments, req.attachments)

    saved_attachments = _save_attachments(project["id"], decoded_attachments)
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
    project = await asyncio.to_thread(load_project, project["id"])
    retryable = None if creation_mode_changed else _retry_info(project)
    if (
        _is_continue_request(req.message)
        and retryable
        and project.get("status") != "running"
        and not _project_has_active_work(project["id"])
    ):
        return await project_retry(project["id"])
    revision_message = req.message if creation_mode_changed else _revision_message_for_continuation(project, req.message)
    revision_result = None if creation_mode_changed else await _handle_local_revision(
        project,
        revision_message,
        saved_attachments,
    )
    if revision_result is not None:
        return revision_result
    if _is_continue_request(req.message) and not creation_mode_changed:
        retryable = _retry_info(project)
        if retryable:
            return await project_retry(project["id"])
    try:
        await _transcribe_candidate(project["id"], req.message, saved_attachments)
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
        "正在思考",
        "正在理解这条消息，并判断应当回答、追问还是开始制作。",
        "running",
        4,
        "brief",
    )
    project = await asyncio.to_thread(load_project, project["id"])
    director_assets = await asyncio.to_thread(
        _hydrate_assets_for_director,
        project["id"],
        saved_attachments,
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
    if _project_has_active_work(project["id"]):
        raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
    with _launching_project(project["id"]):
        def mark_directing(item: dict[str, Any]) -> None:
            item["status"] = "running"
            item["phase"] = "brief"
            item["progress"] = 4
            item["error"] = ""

        await asyncio.to_thread(mutate_project, project["id"], mark_directing)
        if not _track_project_task(
            project["id"],
            _run_director_production(
                project["id"],
                aspect_ratio=aspect_ratio,
                creation_mode=creation_mode,
                director_assets=director_assets,
                saved_attachments=saved_attachments,
                revision_message=revision_message,
                original_message=req.message,
                selected_voice_id=selected_voice_id,
            ),
        ):
            raise HTTPException(409, "当前项目仍有制作任务正在收尾，请稍后再试")
    # The request is acknowledged as soon as its durable server task exists.
    # Director planning, media generation and composition continue even if the
    # user switches tabs, closes the iframe or navigates to another project.
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
