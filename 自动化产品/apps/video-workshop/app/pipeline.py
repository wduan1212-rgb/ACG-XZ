from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import math
import os
import re
import shutil
import time
import traceback
import uuid
import weakref
from pathlib import Path
from typing import Any

from .bgm import bgm_library
from .config import settings
from .media import (
    ASPECTS,
    build_scene_timeline,
    compose_variant,
    normalize_narration,
    probe,
    retime_video,
)
from .openmontage_bridge import openmontage
from .providers import (
    ProviderError,
    _sanitize_seedance_visual_text,
    director,
    seedance,
    tts,
)
from .store import add_event, add_message, load_project, mutate_project


DEFAULT_DELIVERY_SPEED = 1.2
DURATION_OVERRUN_ALLOWANCE = 30.0
DURATION_MEASUREMENT_EPSILON = 1.0
_SEEDANCE_LIMITERS: "weakref.WeakKeyDictionary[Any, asyncio.Semaphore]" = weakref.WeakKeyDictionary()


def _scene_generation_duration(target_duration: float) -> int:
    target = max(0.1, float(target_duration or 0.1))
    return max(4, min(15, int(math.ceil(target - 1e-6))))


def _clip_covers_target(actual_duration: float, target_duration: float) -> bool:
    actual = max(0.0, float(actual_duration or 0))
    # A non-empty generated clip is usable.  The media normalizer maps its
    # continuous motion to the measured narration window without static padding.
    return actual > 0


def _delivery_duration_score(duration: float, requested: float) -> float:
    """Prefer the broad requested window and never prefer an undershoot."""
    delivered = float(duration or 0) / DEFAULT_DELIVERY_SPEED
    lower = float(requested or 0)
    upper = lower + DURATION_OVERRUN_ALLOWANCE + DURATION_MEASUREMENT_EPSILON
    if lower <= delivered <= upper:
        return 0.0
    if delivered < lower:
        return 1000.0 + lower - delivered
    return delivered - upper


async def _generate_duration_aligned_tts(
    plan: dict[str, Any],
    narration_path: Path,
    *,
    voice_id: str | None = None,
    max_revisions: int = 3,
) -> tuple[dict[str, Any], dict[str, Any], float, dict[str, Any], list[dict[str, Any]]]:
    """Generate real TTS and revise topic copy only when measured time misses.

    The measured audio, not character heuristics, decides whether a revision
    is useful. User scripts and uploaded narration are never rewritten.
    """
    current_plan = dict(plan)
    tts_result = await tts.generate(
        str(current_plan.get("narration") or ""),
        narration_path,
        target_duration_sec=None,
        voice_id=voice_id,
    )
    audio_info = await probe(narration_path)
    duration = float(audio_info.get("duration") or 0)
    if duration <= 0:
        raise RuntimeError("口播音频没有可用时长")
    requested = float(current_plan.get("requested_duration_sec") or 0)
    if str(current_plan.get("input_mode") or "topic") != "topic" or requested <= 0:
        return tts_result, audio_info, duration, current_plan, []

    attempts: list[dict[str, Any]] = []
    best_score = _delivery_duration_score(duration, requested)
    for attempt in range(1, max(0, int(max_revisions)) + 1):
        if best_score == 0:
            break
        revised = await director.revise_narration_duration(
            current_plan,
            duration,
            requested,
            DEFAULT_DELIVERY_SPEED,
        )
        if revised == str(current_plan.get("narration") or "").strip():
            break
        candidate_path = narration_path.with_name(
            f".{narration_path.stem}-duration-{attempt}-{uuid.uuid4().hex[:8]}{narration_path.suffix}"
        )
        try:
            candidate_result = await tts.generate(
                revised,
                candidate_path,
                target_duration_sec=None,
                voice_id=voice_id,
            )
            candidate_info = await probe(candidate_path)
            candidate_duration = float(candidate_info.get("duration") or 0)
            candidate_score = _delivery_duration_score(candidate_duration, requested)
            attempts.append({
                "attempt": attempt,
                "duration": round(candidate_duration, 3),
                "deliveryDuration": round(candidate_duration / DEFAULT_DELIVERY_SPEED, 3),
                "accepted": candidate_duration > 0 and candidate_score < best_score,
            })
            if candidate_duration > 0 and candidate_score < best_score:
                candidate_path.replace(narration_path)
                current_plan = {**current_plan, "narration": revised}
                tts_result = {**candidate_result, "path": str(narration_path)}
                audio_info = candidate_info
                duration = candidate_duration
                best_score = candidate_score
        finally:
            candidate_path.unlink(missing_ok=True)

    # A longer result can still be edited safely; an undershoot violates the
    # user's explicit floor and must fail visibly instead of being delivered.
    if duration / DEFAULT_DELIVERY_SPEED < requested:
        raise RuntimeError(
            f"真实口播复核后交付时长仍只有 {duration / DEFAULT_DELIVERY_SPEED:.1f} 秒，"
            f"短于用户要求的 {requested:.0f} 秒，已停止制作，不会交付过短成片。"
        )
    return tts_result, audio_info, duration, current_plan, attempts


async def _gather_cancel_on_error(*awaitables: Any) -> list[Any]:
    """Fail fast without leaving sibling work running during caller cleanup."""
    tasks = [asyncio.create_task(awaitable) for awaitable in awaitables]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


def _seedance_limiter(limit: int = 10) -> asyncio.Semaphore:
    """Share provider capacity across every project on the current app loop."""
    loop = asyncio.get_running_loop()
    semaphore = _SEEDANCE_LIMITERS.get(loop)
    if semaphore is None:
        semaphore = asyncio.Semaphore(max(1, int(limit or 1)))
        _SEEDANCE_LIMITERS[loop] = semaphore
    return semaphore


async def _gather_bounded(
    *awaitables: Any,
    limit: int = 10,
    shared_seedance_slots: bool = False,
) -> list[Any]:
    """Run provider work concurrently without exceeding the upstream queue cap."""
    semaphore = (
        _seedance_limiter(limit)
        if shared_seedance_slots
        else asyncio.Semaphore(max(1, int(limit or 1)))
    )

    async def run_one(awaitable: Any) -> Any:
        started = False
        try:
            async with semaphore:
                started = True
                return await awaitable
        finally:
            # If a sibling fails while this item is still queued, the wrapper
            # can be cancelled before it ever awaits the provider coroutine.
            # Close it explicitly so fail-fast cancellation does not leak an
            # un-awaited coroutine warning or retain request resources.
            if not started and asyncio.iscoroutine(awaitable):
                awaitable.close()

    return await _gather_cancel_on_error(*(run_one(item) for item in awaitables))


def _scene_timeline_weights(scenes: list[dict[str, Any]]) -> list[float]:
    """Blend director rhythm with exact narration-span density."""
    planned = [max(0.1, float(scene.get("duration_sec") or 8)) for scene in scenes]
    speech = [
        len(re.sub(r"[\s，。！？!?；;：:,]", "", str(scene.get("narration_excerpt") or "")))
        for scene in scenes
    ]
    if not speech or any(value <= 0 for value in speech):
        return planned
    planned_total = sum(planned)
    speech_total = sum(speech)
    # Exact口播片段主导真实时间窗；导演原始时长仍保留少量权重，用于语气停顿和视觉节奏判断。
    return [
        0.78 * (text_length / speech_total) + 0.22 * (duration / planned_total)
        for text_length, duration in zip(speech, planned)
    ]


def _visual_beats_for_segment(
    scene: dict[str, Any],
    segment_number: int,
    segment_count: int,
) -> list[dict[str, Any]]:
    beats = [item for item in scene.get("visual_beats") or [] if isinstance(item, dict)]
    if not beats or segment_count <= 1:
        return beats
    # Partition beats once and only once. The previous floor/ceil pair made a
    # middle beat belong to both neighboring segments (for example 3 beats / 2
    # segments), which produced near-identical Seedance clips in long videos.
    start = round(len(beats) * (segment_number - 1) / segment_count)
    end = round(len(beats) * segment_number / segment_count)
    return beats[start:end]


def _render_units(
    scenes: list[dict[str, Any]],
    timeline: list[dict[str, Any]],
    work_dir: Path,
) -> list[dict[str, Any]]:
    """Turn technical time windows into independently generated visual beats.

    The director's logical scene plan stays authoritative.  A long scene is
    only expanded after the real narration duration is known, and every
    expanded window gets its own Seedance source instead of replaying one clip.
    """
    units: list[dict[str, Any]] = []
    for render_index, window in enumerate(timeline, start=1):
        source_number = int(window.get("sourceSceneNumber") or window["sceneNumber"])
        source_scene = dict(scenes[source_number - 1])
        segment_number = int(window.get("segmentNumber") or 1)
        segment_count = int(window.get("segmentCount") or 1)
        target_duration = float(window["duration"])
        base_prompt = _sanitize_seedance_visual_text(source_scene.get("visual_prompt") or "")
        segment_beats = _visual_beats_for_segment(source_scene, segment_number, segment_count)
        semantic_lines: list[str] = []
        visual_identity = _sanitize_seedance_visual_text(source_scene.get("visual_identity") or "")
        if visual_identity:
            semantic_lines.append(f"本段独立视觉身份：{visual_identity}")
        if segment_beats:
            semantic_lines.append(
                "内部镜头变化：同一技术片段可依次完成以下可见动作，每次变化都带来新的主体、"
                "动作阶段、空间关系或观察角度。"
            )
            for beat in segment_beats:
                action = _sanitize_seedance_visual_text(beat.get("visual_action") or "")
                camera = _sanitize_seedance_visual_text(beat.get("camera") or "")
                transition = _sanitize_seedance_visual_text(beat.get("transition") or "")
                pace = str(beat.get("pace") or "").strip()
                pace_text = {
                    "flash": "短促闪切",
                    "quick": "快速推进",
                    "hold": "停留理解",
                    "release": "释放收束",
                }.get(pace, "")
                detail = "；".join(value for value in (
                    action,
                    camera,
                    transition,
                    pace_text,
                ) if value)
                if detail:
                    semantic_lines.append(f"- {detail}")
        if semantic_lines:
            # Repeating the entire base prompt across technical splits makes
            # every generated clip look alike. Keep the shared visual identity
            # for continuity, then describe only this split's unique actions.
            prompt_base = base_prompt
            if segment_count > 1:
                scene_title = _sanitize_seedance_visual_text(source_scene.get("title") or "")
                # The director may omit visual_identity. In that case retain
                # only the leading style/environment sentence, never the full
                # scene prompt whose later actions belong to other segments.
                leading_context = re.split(r"[。！？\n]", base_prompt, maxsplit=1)[0].strip()
                continuity_parts = [value for value in (visual_identity, scene_title) if value]
                if not visual_identity and leading_context:
                    continuity_parts.append(leading_context[:160])
                prompt_base = (
                    "连续性背景：" + "；".join(dict.fromkeys(continuity_parts))
                    if continuity_parts
                    else "保持该叙事段已建立的人物、空间、光线和视觉风格"
                )
            source_scene["visual_prompt"] = f"{prompt_base}\n" + "\n".join(semantic_lines)
        if segment_count > 1:
            source_scene["visual_prompt"] = (
                f"{str(source_scene.get('visual_prompt') or base_prompt).strip()}\n"
                f"这是该叙事段连续推进的第 {segment_number}/{segment_count} 个独立视觉节拍。"
                "仅在叙事确有连续性时延续人物与世界观；使用新的动作阶段、空间职责、构图或镜头运动，"
                "不要复用前一个节拍的主体动作和画面组织。"
            )
        if target_duration >= 8 and not segment_beats:
            source_scene["visual_prompt"] = (
                f"{str(source_scene.get('visual_prompt') or base_prompt).strip()}\n"
                "剪辑判断（非硬性）：先根据口播的列举、反差、动作、证据与情绪转折决定是否在片段内部改变镜头。"
                "需要强调或连续列举时可紧凑快切，需要理解信息、建立情绪或看清结果时主动停留；"
                "不要等间隔切换，也不要为了显得快而制造没有新增价值的镜头。"
            )
        filename = (
            f"scene-{source_number:02d}.mp4"
            if segment_count == 1
            else f"scene-{source_number:02d}-part-{segment_number:02d}.mp4"
        )
        units.append(
            {
                "render_number": render_index,
                "source_scene_number": source_number,
                "segment_number": segment_number,
                "segment_count": segment_count,
                "scene": source_scene,
                "target_duration": target_duration,
                "target_path": work_dir / filename,
            }
        )
    return units


def _merge_timed_asset_placements(
    plan: dict[str, Any],
    placements: list[dict[str, Any]],
) -> None:
    """Apply timing/presentation edits without changing locked asset roles."""
    by_id = {
        str(item.get("asset_id") or ""): item
        for item in placements
        if isinstance(item, dict) and str(item.get("asset_id") or "")
    }
    if not by_id:
        return
    allowed = {
        "scene_number", "narration_anchor", "presentation", "position",
        "scale", "duration_sec", "reason",
    }

    def merge(items: Any) -> list[dict[str, Any]]:
        resolved: list[dict[str, Any]] = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            placement = by_id.get(str(item.get("asset_id") or "")) or {}
            updates = {key: placement[key] for key in allowed if key in placement}
            resolved.append({**item, **updates})
        return resolved

    plan["asset_assignments"] = merge(plan.get("asset_assignments"))
    for key in ("reference_images", "material_assets", "narration_audio", "bgm_assets", "sfx_assets"):
        value = plan.get(key)
        if isinstance(value, list):
            plan[key] = merge(value)
        elif isinstance(value, dict):
            merged = merge([value])
            plan[key] = merged[0] if merged else value


async def _best_effort_thread_call(function: Any, *args: Any, **kwargs: Any) -> None:
    """Run a post-commit notification without changing the committed outcome."""
    try:
        await asyncio.to_thread(function, *args, **kwargs)
    except Exception:
        pass


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _delivery_snapshot(
    delivery_id: str,
    plan: dict[str, Any],
    outputs: list[dict[str, Any]],
    *,
    created_at: int | None = None,
) -> dict[str, Any]:
    return {
        "id": delivery_id,
        "title": str(plan.get("title") or "未命名成片")[:120],
        "createdAt": int(created_at or time.time() * 1000),
        "aspectRatio": str(plan.get("aspect_ratio") or "9:16")[:24],
        "plan": plan,
        "outputs": outputs,
        "publishedDeliveryId": "",
        "publishedAt": 0,
    }


def _output_source_path(project_id: str, output: dict[str, Any]) -> Path | None:
    raw_url = str(output.get("url") or output.get("downloadUrl") or "").split("?", 1)[0]
    prefix = f"/outputs/{project_id}/"
    if not raw_url.startswith(prefix):
        return None
    filename = raw_url[len(prefix):]
    if not filename or Path(filename).name != filename:
        return None
    candidate = (settings.outputs_dir / project_id / filename).resolve()
    root = (settings.outputs_dir / project_id).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def _ensure_legacy_delivery(project_id: str) -> None:
    """Archive a pre-history project's current output before the next render overwrites it."""
    project = load_project(project_id)
    if not project:
        return
    current_outputs = [item for item in (project.get("outputs") or []) if isinstance(item, dict)]
    if not current_outputs:
        return
    known_urls = {
        str(output.get("url") or output.get("downloadUrl") or "")
        for delivery in (project.get("deliveries") or [])
        if isinstance(delivery, dict)
        for output in (delivery.get("outputs") or [])
        if isinstance(output, dict)
    }
    current_urls = {
        str(output.get("url") or output.get("downloadUrl") or "")
        for output in current_outputs
    }
    if current_urls and current_urls.issubset(known_urls):
        return

    fingerprint = hashlib.sha1(
        json.dumps(sorted(current_urls), ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:12]
    delivery_id = f"legacy-{fingerprint}"
    archived_outputs: list[dict[str, Any]] = []
    for index, output in enumerate(current_outputs):
        source = _output_source_path(project_id, output)
        if source is None:
            continue
        target_name = f"delivery-{delivery_id}-{index + 1:02d}{source.suffix.lower() or '.mp4'}"
        target = source.with_name(target_name)
        if source != target and not target.is_file():
            shutil.copy2(source, target)
        archived = dict(output)
        archived["id"] = str(archived.get("id") or f"{delivery_id}-{index + 1}")
        archived["deliveryId"] = delivery_id
        archived["url"] = f"/outputs/{project_id}/{target.name}"
        archived["downloadUrl"] = archived["url"]
        archived_outputs.append(archived)
    if not archived_outputs:
        return

    snapshot = _delivery_snapshot(
        delivery_id,
        project.get("plan") if isinstance(project.get("plan"), dict) else {},
        archived_outputs,
        created_at=int(project.get("updatedAtEpoch") or project.get("createdAtEpoch") or time.time() * 1000),
    )

    def remember(item: dict[str, Any]) -> None:
        deliveries = [row for row in (item.get("deliveries") or []) if isinstance(row, dict)]
        if any(str(row.get("id") or "") == delivery_id for row in deliveries):
            return
        item["deliveries"] = [*deliveries, snapshot][-50:]

    mutate_project(project_id, remember)


class VideoPipeline:
    async def _event(self, project_id: str, title: str, detail: str, progress: int) -> None:
        await asyncio.to_thread(add_event, project_id, title, detail, "running", progress, "production")

    async def create_speed_version(
        self,
        project_id: str,
        output_id: str,
        speed: float,
    ) -> dict[str, Any]:
        project = await asyncio.to_thread(load_project, project_id)
        if not project:
            raise KeyError(project_id)
        source_output: dict[str, Any] | None = None
        for delivery in project.get("deliveries") or []:
            if not isinstance(delivery, dict):
                continue
            for output in delivery.get("outputs") or []:
                if isinstance(output, dict) and str(output.get("id") or "") == output_id:
                    source_output = output
                    break
            if source_output:
                break
        if source_output is None:
            for output in project.get("outputs") or []:
                if isinstance(output, dict) and str(output.get("id") or "") == output_id:
                    source_output = output
                    break
        if source_output is None:
            raise RuntimeError("找不到需要变速的成片版本")

        source_url = str(
            source_output.get("retimeSourceUrl")
            or source_output.get("url")
            or source_output.get("downloadUrl")
            or ""
        )
        source_path = _output_source_path(project_id, {"url": source_url})
        if source_path is None:
            raise RuntimeError("原始成片文件不存在，无法生成新的变速版本")

        delivery_id = uuid.uuid4().hex[:16]
        rate = max(1.2, min(2.0, float(speed or DEFAULT_DELIVERY_SPEED)))
        target_name = f"delivery-{delivery_id}-01-speed-{rate:.1f}".replace(".", "p") + ".mp4"
        target_path = source_path.with_name(target_name)
        result_probe = await retime_video(source_path, target_path, rate)
        output = {
            **source_output,
            "id": f"{delivery_id}-1",
            "deliveryId": delivery_id,
            "label": f"{source_output.get('aspectRatio') or '9:16'} · {rate:.1f}x 成片",
            "url": f"/outputs/{project_id}/{target_name}",
            "downloadUrl": f"/outputs/{project_id}/{target_name}",
            "probe": result_probe,
            "speed": rate,
            "sourceDuration": float(
                source_output.get("sourceDuration")
                or (source_output.get("probe") or {}).get("duration")
                or 0
            ),
            "retimeSourceUrl": source_url,
        }
        plan = project.get("plan") if isinstance(project.get("plan"), dict) else {}
        delivery = _delivery_snapshot(delivery_id, plan, [output])

        def remember(item: dict[str, Any]) -> None:
            deliveries = [row for row in item.get("deliveries") or [] if isinstance(row, dict)]
            item["deliveries"] = [delivery, *deliveries][:50]
            item["outputs"] = [output]
            item["activeDeliveryId"] = delivery_id

        await asyncio.to_thread(mutate_project, project_id, remember)
        await _best_effort_thread_call(
            add_message,
            project_id,
            "assistant",
            f"已基于原成片生成新的 {rate:.1f} 倍速版本，没有重新生成镜头或口播。",
            kind="delivery",
        )
        return output

    @staticmethod
    def _reference_images(
        project_id: str,
        plan: dict[str, Any],
        source_scene_number: int | None = None,
    ) -> list[str]:
        data_urls = []
        for item in list(plan.get("reference_images") or [])[:3]:
            assigned_scene = int(item.get("scene_number") or 0)
            # New plans scope each reference to the director-selected logical
            # scene.  Legacy plans did not persist scene_number, so preserve
            # their prior global behavior for safe resume compatibility.
            if (
                source_scene_number is not None
                and assigned_scene > 0
                and assigned_scene != int(source_scene_number)
            ):
                continue
            filename = Path(str(item.get("url") or "")).name
            if not filename:
                continue
            path = settings.uploads_dir / project_id / filename
            if not path.is_file() or path.stat().st_size > 12 * 1024 * 1024:
                continue
            mime = str(item.get("mime") or "image/png").lower()
            encoded = base64.b64encode(path.read_bytes()).decode("ascii")
            data_urls.append(f"data:{mime};base64,{encoded}")
        return data_urls

    @staticmethod
    def _material_assets(project_id: str, plan: dict[str, Any]) -> list[dict[str, Any]]:
        resolved: list[dict[str, Any]] = []
        scenes = [item for item in plan.get("scenes") or [] if isinstance(item, dict)]
        for item in list(plan.get("material_assets") or []):
            filename = Path(str(item.get("url") or "")).name
            path = settings.uploads_dir / project_id / filename
            if not filename or not path.is_file():
                continue
            scene_number = max(1, min(len(scenes) or 1, int(item.get("scene_number") or 1)))
            scene_excerpt = (
                str(scenes[scene_number - 1].get("narration_excerpt") or "")
                if scenes
                else ""
            )
            resolved.append({
                **item,
                "path": str(path),
                "scene_narration_excerpt": scene_excerpt,
            })
        return resolved

    @staticmethod
    def _audio_assets(project_id: str, plan: dict[str, Any], key: str) -> list[dict[str, Any]]:
        resolved: list[dict[str, Any]] = []
        for item in list(plan.get(key) or []):
            filename = Path(str(item.get("url") or "")).name
            path = settings.uploads_dir / project_id / filename
            if filename and path.is_file():
                resolved.append({**item, "path": str(path)})
        return resolved

    @staticmethod
    def _failure_info(detail: str) -> tuple[str, dict[str, Any] | None]:
        scene_match = re.search(r"第\s*(\d+)\s*段", detail)
        lowered = detail.lower()
        reason = ""
        if any(marker in lowered for marker in ("copyright restriction", "related to copyright", "copyright policy")):
            reason = "copyright"
        elif any(
            marker in lowered
            for marker in ("sensitive information", "content safety", "safety policy", "risk control")
        ):
            reason = "safety"
        if reason and scene_match:
            scene_number = int(scene_match.group(1))
            public_detail = (
                f"镜头 {scene_number} 未通过版权风险审核，可以改写为原创中性视觉后只重试这个镜头。"
                if reason == "copyright"
                else f"镜头 {scene_number} 未通过内容安全审核，可以安全改写后只重试这个镜头。"
            )
            return (
                public_detail,
                {"type": "safe_rewrite", "sceneNumber": scene_number, "reason": reason},
            )
        return detail, None

    async def run(
        self,
        project_id: str,
        plan: dict[str, Any],
        retry_scene_number: int | None = None,
        *,
        recompose_only: bool = False,
    ) -> None:
        work_dir = settings.outputs_dir / project_id
        work_dir.mkdir(parents=True, exist_ok=True)
        temporary_scene_paths: set[Path] = set()
        scene_backups: list[tuple[Path, Path]] = []
        project_committed = False
        try:
            await asyncio.to_thread(_ensure_legacy_delivery, project_id)
            scenes = [scene for scene in list(plan.get("scenes") or []) if isinstance(scene, dict)]
            if not scenes:
                raise RuntimeError("导演计划没有可执行镜头")
            if retry_scene_number and recompose_only:
                raise RuntimeError("不能同时重生成镜头并只重合成字幕")
            if recompose_only:
                await self._event(
                    project_id,
                    "正在复用原音画重新合成",
                    "本次不会调用视频生成或口播生成，只按真实口播时长重新建立音画时间线。",
                    20,
                )
            elif retry_scene_number:
                await self._event(
                    project_id,
                    f"正在重试镜头 {retry_scene_number}",
                    "已保留成功素材，本次只生成需要恢复的镜头。",
                    20,
                )
            else:
                await self._event(
                    project_id,
                    "导演计划已锁定",
                    str(plan.get("director_note") or f"{len(scenes)} 个镜头已确认，开始并行生成画面与声音。"),
                    12,
                )
            plan_path = work_dir / "director-plan.json"
            plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")

            async def callback(title: str, detail: str, progress: int) -> None:
                await self._event(project_id, title, detail, progress)

            narration_path = work_dir / "narration.mp3"
            narration_asset = plan.get("narration_audio") if isinstance(plan.get("narration_audio"), dict) else None
            narration_source = None
            if narration_asset:
                filename = Path(str(narration_asset.get("url") or "")).name
                candidate = settings.uploads_dir / project_id / filename
                narration_source = candidate if filename and candidate.is_file() else None
            selected_bgm = bgm_library.resolve(project_id, plan)
            audio_design = plan.get("audio_design") if isinstance(plan.get("audio_design"), dict) else {}
            tts_result: dict[str, Any] = {"path": str(narration_path), "reused": True}
            audio_info: dict[str, Any] | None = None
            narration_duration = 0.0
            duration_alignment: list[dict[str, Any]] = []
            if recompose_only:
                if not narration_path.is_file():
                    raise RuntimeError("原口播文件不存在，无法复用原音画重新合成")
            elif not retry_scene_number or not narration_path.is_file():
                if narration_source:
                    await self._event(
                        project_id,
                        "正在标准化口播音频",
                        "先确认原音频的真实时长，再安排每个视频镜头。",
                        16,
                    )
                    normalized_probe = await normalize_narration(narration_source, narration_path)
                    tts_result = {
                        "path": str(narration_path),
                        "source": "uploaded",
                        "sourceAssetId": narration_asset.get("asset_id") if narration_asset else "",
                        "probe": normalized_probe,
                    }
                else:
                    await self._event(
                        project_id,
                        "正在生成口播",
                        "口播完成后会先测量真实时长，再提交对应长度的镜头。",
                        16,
                    )
                    (
                        tts_result,
                        audio_info,
                        narration_duration,
                        plan,
                        duration_alignment,
                    ) = await _generate_duration_aligned_tts(
                        plan,
                        narration_path,
                        voice_id=str(plan.get("voice_id") or "").strip() or None,
                    )

            if audio_info is None:
                audio_info = await probe(narration_path)
                narration_duration = float(audio_info.get("duration") or 0)
            if narration_duration <= 0:
                raise RuntimeError("口播音频没有可用时长")
            if duration_alignment:
                await self._event(
                    project_id,
                    "口播时长已按真实音频复核",
                    f"已依据 MiniMax 实测时长完成 {len(duration_alignment)} 次口播复核，"
                    f"默认 {DEFAULT_DELIVERY_SPEED:.1f}x 交付约 {narration_duration / DEFAULT_DELIVERY_SPEED:.1f} 秒。",
                    18,
                )
            if not recompose_only and not retry_scene_number:
                await self._event(
                    project_id,
                    "正在按真实口播锁定视觉分镜",
                    "故事和口播保持不变；视觉导演正在逐段核对独立画面、附件时机和全片重复项。",
                    19,
                )
                timed_plan = await director.lock_timed_visual_plan(plan, narration_duration)
                plan = {
                    **plan,
                    "scenes": timed_plan["scenes"],
                    "duration_sec": round(narration_duration, 3),
                    "timed_visual_editor": {
                        "actual_duration": round(narration_duration, 3),
                        "minimum_units": timed_plan["minimum_units"],
                        "scene_count": len(timed_plan["scenes"]),
                        "public_summary": timed_plan["public_summary"],
                    },
                }
                _merge_timed_asset_placements(plan, timed_plan.get("asset_placements") or [])
                scenes = [scene for scene in plan["scenes"] if isinstance(scene, dict)]

                def remember_timed_plan(item: dict[str, Any]) -> None:
                    item["plan"] = plan

                await asyncio.to_thread(mutate_project, project_id, remember_timed_plan)
                plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
                await self._event(
                    project_id,
                    "真实时序分镜已锁定",
                    f"{len(scenes)} 个纯视觉生成单元覆盖 {narration_duration:.1f} 秒口播；"
                    "相邻重复、口播文字泄漏和素材错位已在提交前复核。",
                    20,
                )
            material_assets = self._material_assets(project_id, plan)
            sfx_assets = self._audio_assets(project_id, plan, "sfx_assets")
            scene_durations = _scene_timeline_weights(scenes)
            scene_timeline, _transition_duration = build_scene_timeline(
                scene_durations,
                narration_duration,
            )
            render_units = _render_units(scenes, scene_timeline, work_dir)
            (work_dir / "render-plan.json").write_text(
                json.dumps(
                    {
                        "narration_duration": narration_duration,
                        "units": [
                            {
                                "render_number": int(unit["render_number"]),
                                "source_scene_number": int(unit["source_scene_number"]),
                                "segment_number": int(unit["segment_number"]),
                                "segment_count": int(unit["segment_count"]),
                                "target_duration": round(float(unit["target_duration"]), 3),
                                "visual_prompt": str(unit["scene"].get("visual_prompt") or ""),
                                "visual_identity": str(unit["scene"].get("visual_identity") or ""),
                            }
                            for unit in render_units
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            generation_durations = (
                []
                if recompose_only
                else [
                    _scene_generation_duration(float(unit["target_duration"]))
                    for unit in render_units
                ]
            )
            await self._event(
                project_id,
                "口播时间线已锁定",
                f"口播实测 {narration_duration:.1f} 秒，"
                f"已按真实时长编排 {len(render_units)} 个独立视觉节拍。",
                20,
            )

            scene_jobs: list[dict[str, Any]] = []
            for index, unit in enumerate(render_units):
                scene_number = int(unit["render_number"])
                source_scene_number = int(unit["source_scene_number"])
                should_generate = (
                    not recompose_only
                    and (
                        not retry_scene_number
                        or source_scene_number == retry_scene_number
                        or not Path(unit["target_path"]).is_file()
                    )
                )
                if not should_generate:
                    continue
                target_path = Path(unit["target_path"])
                candidate_path = work_dir / (
                    f".scene-{scene_number:02d}-{uuid.uuid4().hex[:10]}.candidate.mp4"
                )
                temporary_scene_paths.add(candidate_path)
                duration_sec = generation_durations[index]
                scene_jobs.append(
                    {
                        "scene_number": scene_number,
                        "source_scene_number": source_scene_number,
                        "segment_number": int(unit["segment_number"]),
                        "scene": unit["scene"],
                        "target_path": target_path,
                        "candidate_path": candidate_path,
                        "had_existing": target_path.is_file(),
                        "target_duration": float(unit["target_duration"]),
                        "duration_sec": generation_durations[index],
                        "reference_images": self._reference_images(
                            project_id,
                            plan,
                            source_scene_number,
                        ),
                    }
                )

            if recompose_only:
                for unit in render_units:
                    target_path = Path(unit["target_path"])
                    if target_path.is_file():
                        continue
                    # Pre-upgrade projects only have one file per logical
                    # director scene.  Recomposition may reuse that legacy
                    # source, but new productions always create independent
                    # files for every expanded beat.
                    legacy_path = work_dir / f"scene-{int(unit['source_scene_number']):02d}.mp4"
                    if legacy_path.is_file():
                        unit["target_path"] = legacy_path
                        continue
                    raise RuntimeError(
                        "原镜头文件不完整，无法复用原音画重新合成：" + target_path.name
                    )
                await self._event(
                    project_id,
                    "原音画已复用",
                    f"已保留口播和 {len(render_units)} 个视觉节拍，只重新建立时间线与最终成片。",
                    24,
                )
            elif retry_scene_number:
                reused = []
                if narration_path.is_file():
                    reused.append("口播")
                reused.extend(
                    f"镜头 {int(unit['render_number'])}"
                    for unit in render_units
                    if int(unit["source_scene_number"]) != retry_scene_number
                    and Path(unit["target_path"]).is_file()
                )
                await self._event(
                    project_id,
                    "成功素材已复用",
                    f"已保留{' 、'.join(reused) or '已有文件'}，避免重复生成。",
                    22,
                )
            else:
                await self._event(
                    project_id,
                    "画面正在并行生成",
                    f"{len(scene_jobs)} 个镜头已按真实口播时长同时排队。",
                    24,
                )

            await _gather_bounded(
                *(
                    seedance.generate(
                        str(job["scene"].get("visual_prompt") or ""),
                        str(plan.get("aspect_ratio") or "9:16"),
                        Path(job["candidate_path"]),
                        callback=callback,
                        # Provider-facing failures must map back to the
                        # director's logical scene so "continue missing shot"
                        # remains usable even when that scene was expanded
                        # into several independently rendered visual beats.
                        scene_number=int(job["source_scene_number"]),
                        reference_images=job["reference_images"],
                        duration_sec=int(job["duration_sec"]),
                    )
                    for job in scene_jobs
                ),
                shared_seedance_slots=True,
            )

            async def validate_scene_candidate(job: dict[str, Any]) -> dict[str, Any]:
                candidate_path = Path(job["candidate_path"])
                info = await probe(candidate_path)
                actual_duration = float(info.get("duration") or 0)
                target_duration = float(job["target_duration"])
                if _clip_covers_target(actual_duration, target_duration):
                    return info
                retry_duration = min(
                    15,
                    max(
                        int(job["duration_sec"]) + 1,
                        _scene_generation_duration(target_duration),
                    ),
                )
                if retry_duration <= int(job["duration_sec"]):
                    raise RuntimeError(
                        f"镜头 {job['scene_number']} 实测 {actual_duration:.2f} 秒，"
                        f"无法覆盖 {target_duration:.2f} 秒口播时间窗；"
                        "已停止合成，不使用长静止尾帧补齐。"
                    )
                await self._event(
                    project_id,
                    f"镜头 {job['scene_number']} 时长不足，正在单独重试",
                    f"从 {job['duration_sec']} 秒调整为 {retry_duration} 秒，其他镜头不会重复生成。",
                    58,
                )
                await _gather_bounded(
                    seedance.generate(
                        str(job["scene"].get("visual_prompt") or ""),
                        str(plan.get("aspect_ratio") or "9:16"),
                        candidate_path,
                        callback=callback,
                        scene_number=int(job["source_scene_number"]),
                        reference_images=job["reference_images"],
                        duration_sec=retry_duration,
                    ),
                    shared_seedance_slots=True,
                )
                job["duration_sec"] = retry_duration
                info = await probe(candidate_path)
                actual_duration = float(info.get("duration") or 0)
                if not _clip_covers_target(actual_duration, target_duration):
                    failure_action = (
                        "已保留旧镜头并停止合成。"
                        if bool(job["had_existing"])
                        else "已停止合成，可只继续缺失镜头。"
                    )
                    raise RuntimeError(
                        f"镜头 {job['scene_number']} 重试后实测 {actual_duration:.2f} 秒，"
                        f"仍无法覆盖 {target_duration:.2f} 秒口播时间窗；"
                        + failure_action
                    )
                return info

            if scene_jobs:
                await _gather_bounded(
                    *(validate_scene_candidate(job) for job in scene_jobs)
                )

            render_scene_paths = [Path(unit["target_path"]) for unit in render_units]
            delayed_replacements: list[tuple[Path, Path]] = []
            for job in scene_jobs:
                candidate_path = Path(job["candidate_path"])
                target_path = Path(job["target_path"])
                scene_index = int(job["scene_number"]) - 1
                if bool(job["had_existing"]):
                    render_scene_paths[scene_index] = candidate_path
                    delayed_replacements.append((candidate_path, target_path))
                else:
                    candidate_path.replace(target_path)
                    temporary_scene_paths.discard(candidate_path)
                    render_scene_paths[scene_index] = target_path

            await self._event(
                project_id,
                "原音画读取完成" if recompose_only else "素材生成完成",
                (
                    f"口播与 {len(render_units)} 个原视觉节拍均已读取，准备重新合成成片。"
                    if recompose_only
                    else f"口播与 {len(render_units)} 个独立视觉节拍均已就绪，准备按真实口播时长合成。"
                ),
                62,
            )

            composition = {
                "render_runtime": "ffmpeg",
                "cuts": [
                    {
                        "id": f"scene-{index:02d}",
                        "sourceSceneNumber": index,
                        "directorSceneNumber": int(scene.get("sourceSceneNumber") or scene["sceneNumber"]),
                        "segmentNumber": int(scene.get("segmentNumber") or 1),
                        "source": str(render_scene_paths[index - 1]),
                        "in_seconds": round(float(scene["start"]), 3),
                        "out_seconds": round(float(scene["end"]), 3),
                    }
                    for index, scene in enumerate(scene_timeline, start=1)
                ],
                "audio": {
                    "narration": {
                        "src": str(narration_path),
                        "duration_seconds": narration_duration,
                        "source": "uploaded" if narration_source else "generated",
                    },
                    "bgm": {
                        "src": str(selected_bgm.path) if selected_bgm else "",
                        "track_id": selected_bgm.id if selected_bgm else "",
                        "name": selected_bgm.name if selected_bgm else "",
                        "source": selected_bgm.source if selected_bgm else "",
                        "volume": float(audio_design.get("bgm_volume") or 0.12),
                    },
                },
                "subtitles": {
                    "enabled": True,
                    "style": "phrase-animated",
                    "outline": "thin",
                    "safe_area": "responsive",
                    "revision": plan.get("subtitle_style") or {},
                },
                "materials": [
                    {
                        key: item.get(key)
                        for key in ("asset_id", "label", "name", "mime", "scene_number", "narration_anchor", "duration_sec", "reason")
                    }
                    for item in material_assets
                ],
                "sound_effects": [
                    {
                        key: item.get(key)
                        for key in (
                            "asset_id",
                            "label",
                            "name",
                            "scene_number",
                            "narration_anchor",
                            "duration_sec",
                            "volume",
                        )
                    }
                    for item in sfx_assets
                ],
            }
            composition_path = work_dir / "composition.json"
            composition_path.write_text(json.dumps(composition, ensure_ascii=False, indent=2), encoding="utf-8")
            validation = await asyncio.to_thread(
                openmontage.validate_composition,
                composition_path,
                work_dir,
            )
            if not validation.get("success"):
                raise RuntimeError(f"合成前检查失败：{validation.get('error') or validation.get('data')}")
            (work_dir / "composition-validation.json").write_text(
                json.dumps(validation, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            await self._event(
                project_id,
                "合成前检查通过",
                "素材路径、时间线覆盖和口播时长已经核对。",
                68,
            )
            if material_assets:
                await self._event(
                    project_id,
                    "用户素材时间点已锁定",
                    "、".join(str(item.get("label") or item.get("name") or "素材") for item in material_assets)
                    + " 将按口播语义插入对应画面。",
                    70,
                )

            aspect_order = [str(plan.get("aspect_ratio") or "9:16")]
            variants = []
            for index, aspect_ratio in enumerate(aspect_order):
                await self._event(
                    project_id,
                    f"正在合成 {aspect_ratio} 版本",
                    "重构安全区并烧录轻描边动效字幕。",
                    70 + index * 7,
                )
                variant = await compose_variant(
                    render_scene_paths,
                    narration_path,
                    str(plan["narration"]),
                    aspect_ratio,
                    work_dir,
                    material_assets=material_assets,
                    scene_durations=[float(unit["target_duration"]) for unit in render_units],
                    bgm_path=selected_bgm.path if selected_bgm else None,
                    bgm_volume=float(audio_design.get("bgm_volume") or 0.12),
                    sfx_assets=sfx_assets,
                    subtitle_style=(
                        plan.get("subtitle_style")
                        if isinstance(plan.get("subtitle_style"), dict)
                        else None
                    ),
                )
                if (variant.get("probe") or {}).get("syncRepaired"):
                    await self._event(
                        project_id,
                        "已自动重校合成时间线",
                        "检测到成片编码偏差，已保持口播不变并按口播时间线重对齐画面。",
                        77,
                    )
                variants.append(variant)

            await self._event(
                project_id,
                "正在生成默认节奏版",
                "保留原始合成文件，仅对最终音画整体做 1.2 倍速处理。",
                84,
            )
            for variant in variants:
                source_path = Path(variant["path"])
                speed_path = source_path.with_name(
                    f"{source_path.stem}-speed-1p2{source_path.suffix}"
                )
                source_probe = dict(variant.get("probe") or {})
                variant["path"] = speed_path
                variant["sourcePath"] = source_path
                variant["sourceProbe"] = source_probe
                variant["probe"] = await retime_video(
                    source_path,
                    speed_path,
                    DEFAULT_DELIVERY_SPEED,
                )
                variant["speed"] = DEFAULT_DELIVERY_SPEED
                if variant["probe"].get("syncRepaired"):
                    await self._event(
                        project_id,
                        "已自动重校音画节奏",
                        "检测到明显编码偏差，已保持口播不变并按口播时间线重对齐画面。",
                        86,
                    )

            qa_results = []
            for variant in variants:
                review_dir = work_dir / f"qa-{variant['aspectRatio'].replace(':', 'x')}"
                qa = await asyncio.to_thread(
                    openmontage.inspect_video,
                    variant["path"],
                    variant["width"],
                    variant["height"],
                    review_dir,
                    narration_duration / DEFAULT_DELIVERY_SPEED,
                )
                qa_results.append({"aspectRatio": variant["aspectRatio"], **qa})
            qa_path = work_dir / "openmontage-qa.json"
            qa_path.write_text(json.dumps(qa_results, ensure_ascii=False, indent=2), encoding="utf-8")
            failed_qa = [item for item in qa_results if not item.get("success")]
            if failed_qa:
                raise RuntimeError("成片质检未通过，请查看内部质检记录")

            delivery_id = uuid.uuid4().hex[:16]
            outputs = []
            for output_index, variant in enumerate(variants, start=1):
                source_path = Path(variant["path"])
                filename = f"delivery-{delivery_id}-{output_index:02d}{source_path.suffix.lower() or '.mp4'}"
                archived_path = source_path.with_name(filename)
                await asyncio.to_thread(shutil.copy2, source_path, archived_path)
                retime_source = Path(variant.get("sourcePath") or source_path)
                retime_source_name = f"delivery-{delivery_id}-source-{output_index:02d}{retime_source.suffix.lower() or '.mp4'}"
                retime_source_archive = source_path.with_name(retime_source_name)
                await asyncio.to_thread(shutil.copy2, retime_source, retime_source_archive)
                outputs.append(
                    {
                        "id": f"{delivery_id}-{output_index}",
                        "deliveryId": delivery_id,
                        "label": f"{variant['aspectRatio']} 成片",
                        "aspectRatio": variant["aspectRatio"],
                        "url": f"/outputs/{project_id}/{filename}",
                        "downloadUrl": f"/outputs/{project_id}/{filename}",
                        "retimeSourceUrl": f"/outputs/{project_id}/{retime_source_name}",
                        "probe": variant["probe"],
                        "speed": float(variant.get("speed") or 1.0),
                        "sourceDuration": float(
                            (variant.get("sourceProbe") or {}).get("duration") or 0
                        ),
                        "captionCueCount": len(variant["captionCues"]),
                        "materialCueCount": len(variant.get("materialCues") or []),
                        "materialCues": variant.get("materialCues") or [],
                        "sfxCueCount": len(variant.get("sfxCues") or []),
                        "sfxCues": variant.get("sfxCues") or [],
                        "bgm": (
                            {
                                "id": selected_bgm.id,
                                "name": selected_bgm.name,
                                "source": selected_bgm.source,
                            }
                            if selected_bgm
                            else None
                        ),
                    }
                )

            delivery = _delivery_snapshot(delivery_id, plan, outputs)

            for candidate_path, target_path in delayed_replacements:
                backup_path = target_path.with_name(
                    f".{target_path.name}.{uuid.uuid4().hex[:10]}.backup"
                )
                os.link(target_path, backup_path)
                scene_backups.append((target_path, backup_path))
                candidate_path.replace(target_path)
                temporary_scene_paths.discard(candidate_path)
            if delayed_replacements:
                for cut_index, cut in enumerate(composition["cuts"]):
                    cut["source"] = str(Path(render_units[cut_index]["target_path"]))
                composition_path.write_text(
                    json.dumps(composition, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )

            def complete(project: dict[str, Any]) -> None:
                project["status"] = "succeeded"
                project["phase"] = "delivery"
                project["progress"] = 100
                project["outputs"] = outputs
                existing_deliveries = [
                    item for item in (project.get("deliveries") or [])
                    if isinstance(item, dict) and str(item.get("id") or "") != delivery_id
                ]
                project["deliveries"] = [delivery, *existing_deliveries][:50]
                project["activeDeliveryId"] = delivery_id
                project["qa"] = qa_results
                project["production"] = {
                    "tts": tts_result,
                    "sceneCount": len(scenes),
                    "narrationDuration": narration_duration,
                    "narrationSource": "uploaded" if narration_source else "generated",
                    "bgm": (
                        {"id": selected_bgm.id, "name": selected_bgm.name, "source": selected_bgm.source}
                        if selected_bgm
                        else None
                    ),
                    "qualityCheck": "passed",
                    "deliverySpeed": DEFAULT_DELIVERY_SPEED,
                }
                project["error"] = ""
                project["retryable"] = None

            await asyncio.to_thread(mutate_project, project_id, complete)
            project_committed = True
            for _target_path, backup_path in scene_backups:
                _unlink_quietly(backup_path)
            scene_backups.clear()
            await _best_effort_thread_call(
                add_event,
                project_id,
                "成片与画幅质检完成",
                f"{aspect_order[0]} 画幅已包含音频、H.264 画面、已烧录字幕和默认 1.2 倍速节奏版。",
                "done",
                100,
                "delivery",
            )
            await _best_effort_thread_call(
                add_message,
                project_id,
                "assistant",
                f"成片完成。我按照需求输出了 {aspect_order[0]} 的默认 1.2 倍速版本，并检查了时长、分辨率、音频和关键帧。",
                kind="delivery",
            )
        except Exception as exc:
            detail = str(exc) or exc.__class__.__name__
            public_detail, retryable = self._failure_info(detail)

            def fail(project: dict[str, Any]) -> None:
                project["status"] = "failed"
                project["phase"] = "error"
                project["error"] = public_detail[:1600]
                project["retryable"] = retryable

            await asyncio.to_thread(mutate_project, project_id, fail)
            await asyncio.to_thread(
                add_event,
                project_id,
                "制作中断",
                public_detail[:500],
                "error",
                None,
                "error",
            )
            await asyncio.to_thread(
                add_message,
                project_id,
                "assistant",
                f"制作在当前步骤停住了：{public_detail[:500]}",
                kind="error",
            )
            error_log = work_dir / "error.log"
            error_log.write_text(traceback.format_exc(), encoding="utf-8")
        finally:
            if not project_committed:
                for target_path, backup_path in reversed(scene_backups):
                    if backup_path.is_file():
                        backup_path.replace(target_path)
            for candidate_path in temporary_scene_paths:
                _unlink_quietly(candidate_path)
            for _target_path, backup_path in scene_backups:
                _unlink_quietly(backup_path)


pipeline = VideoPipeline()
