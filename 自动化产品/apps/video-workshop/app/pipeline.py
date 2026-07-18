from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import shutil
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

from .bgm import bgm_library
from .config import settings
from .media import ASPECTS, build_scene_timeline, compose_variant, normalize_narration, probe
from .openmontage_bridge import openmontage
from .providers import ProviderError, seedance, tts
from .store import add_event, add_message, load_project, mutate_project


def _generated_narration_matches_target(
    actual_duration: float,
    target_duration: float,
) -> bool:
    actual = max(0.0, float(actual_duration or 0))
    target = max(0.0, float(target_duration or 0))
    if target <= 0:
        return True
    allowed_delta = max(1.5, target * 0.1)
    return actual > 0 and abs(actual - target) <= allowed_delta


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

    @staticmethod
    def _reference_images(project_id: str, plan: dict[str, Any]) -> list[str]:
        data_urls = []
        for item in list(plan.get("reference_images") or [])[:3]:
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
        for item in list(plan.get("material_assets") or []):
            filename = Path(str(item.get("url") or "")).name
            path = settings.uploads_dir / project_id / filename
            if not filename or not path.is_file():
                continue
            resolved.append({**item, "path": str(path)})
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
    ) -> None:
        work_dir = settings.outputs_dir / project_id
        work_dir.mkdir(parents=True, exist_ok=True)
        try:
            await asyncio.to_thread(_ensure_legacy_delivery, project_id)
            scenes = [scene for scene in list(plan.get("scenes") or []) if isinstance(scene, dict)]
            if not scenes:
                raise RuntimeError("导演计划没有可执行镜头")
            if retry_scene_number:
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
            scene_paths = [work_dir / f"scene-{index:02d}.mp4" for index in range(1, len(scenes) + 1)]
            reference_images = self._reference_images(project_id, plan)
            material_assets = self._material_assets(project_id, plan)
            sfx_assets = self._audio_assets(project_id, plan, "sfx_assets")
            narration_asset = plan.get("narration_audio") if isinstance(plan.get("narration_audio"), dict) else None
            narration_source = None
            if narration_asset:
                filename = Path(str(narration_asset.get("url") or "")).name
                candidate = settings.uploads_dir / project_id / filename
                narration_source = candidate if filename and candidate.is_file() else None
            selected_bgm = bgm_library.resolve(project_id, plan)
            audio_design = plan.get("audio_design") if isinstance(plan.get("audio_design"), dict) else {}
            jobs: list[tuple[str, int | None, Any]] = []
            tts_result: dict[str, Any] = {"path": str(narration_path), "reused": True}
            if not retry_scene_number or not narration_path.is_file():
                if narration_source:
                    jobs.append(("narration", None, normalize_narration(narration_source, narration_path)))
                else:
                    requested_duration = (
                        float(plan.get("requested_duration_sec") or 0)
                        if str(plan.get("input_mode") or "") == "topic"
                        else 0.0
                    )
                    jobs.append(
                        (
                            "tts",
                            None,
                            tts.generate(
                                str(plan["narration"]),
                                narration_path,
                                target_duration_sec=requested_duration or None,
                                voice_id=str(plan.get("voice_id") or "").strip() or None,
                            ),
                        )
                    )

            for index, scene in enumerate(scenes):
                scene_number = index + 1
                should_generate = (
                    not retry_scene_number
                    or scene_number == retry_scene_number
                    or not scene_paths[index].is_file()
                )
                if not should_generate:
                    continue
                if retry_scene_number and scene_number == retry_scene_number:
                    scene_paths[index].unlink(missing_ok=True)
                jobs.append(
                    (
                        "scene",
                        scene_number,
                        seedance.generate(
                            str(scene.get("visual_prompt") or ""),
                            str(plan.get("aspect_ratio") or "9:16"),
                            scene_paths[index],
                            callback=callback,
                            scene_number=scene_number,
                            reference_images=reference_images,
                            duration_sec=int(scene.get("duration_sec") or 8),
                        ),
                    )
                )

            if retry_scene_number:
                reused = []
                if narration_path.is_file():
                    reused.append("口播")
                reused.extend(
                    f"镜头 {index + 1}"
                    for index, path in enumerate(scene_paths)
                    if index + 1 != retry_scene_number and path.is_file()
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
                    "声音与画面并行生成",
                    (
                        f"用户口播音频正在标准化，{len(scenes)} 个视频镜头任务同时排队。"
                        if narration_source
                        else f"指定音色正在合成口播，{len(scenes)} 个视频镜头任务同时排队。"
                    ),
                    18,
                )

            results = await asyncio.gather(
                *(job[2] for job in jobs),
                return_exceptions=True,
            )
            failures: list[BaseException] = []
            for (kind, _scene_number, _job), result in zip(jobs, results):
                if isinstance(result, BaseException):
                    failures.append(result)
                elif kind == "tts":
                    tts_result = result
                elif kind == "narration":
                    tts_result = {
                        "path": str(narration_path),
                        "source": "uploaded",
                        "sourceAssetId": narration_asset.get("asset_id") if narration_asset else "",
                        "probe": result,
                    }
            if failures:
                raise failures[0]
            await self._event(
                project_id,
                "素材生成完成",
                f"口播与 {len(scenes)} 个导演镜头均已下载到本地，准备按真实口播时长建立时间线。",
                62,
            )

            audio_info = await probe(narration_path)
            narration_duration = float(audio_info.get("duration") or 0)
            if narration_duration <= 0:
                raise RuntimeError("口播音频没有可用时长")
            requested_duration = (
                float(plan.get("requested_duration_sec") or 0)
                if not narration_source and str(plan.get("input_mode") or "") == "topic"
                else 0.0
            )
            if requested_duration:
                if not _generated_narration_matches_target(
                    narration_duration,
                    requested_duration,
                ):
                    raise RuntimeError(
                        f"生成口播实测 {narration_duration:.1f} 秒，"
                        f"与用户要求的 {requested_duration:.0f} 秒偏差过大；"
                        "已停止合成，避免用静音或异常语速补足。"
                    )
            scene_durations = [int(scene.get("duration_sec") or 8) for scene in scenes]
            scene_timeline, _transition_duration = build_scene_timeline(scene_durations, narration_duration)

            composition = {
                "render_runtime": "ffmpeg",
                "cuts": [
                    {
                        "id": f"scene-{index:02d}",
                        "source": str(scene_paths[index - 1]),
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
                    scene_paths,
                    narration_path,
                    str(plan["narration"]),
                    aspect_ratio,
                    work_dir,
                    material_assets=material_assets,
                    scene_durations=scene_durations,
                    bgm_path=selected_bgm.path if selected_bgm else None,
                    bgm_volume=float(audio_design.get("bgm_volume") or 0.12),
                    sfx_assets=sfx_assets,
                )
                variants.append(variant)

            qa_results = []
            for variant in variants:
                review_dir = work_dir / f"qa-{variant['aspectRatio'].replace(':', 'x')}"
                qa = await asyncio.to_thread(
                    openmontage.inspect_video,
                    variant["path"],
                    variant["width"],
                    variant["height"],
                    review_dir,
                    narration_duration,
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
                outputs.append(
                    {
                        "id": f"{delivery_id}-{output_index}",
                        "deliveryId": delivery_id,
                        "label": f"{variant['aspectRatio']} 成片",
                        "aspectRatio": variant["aspectRatio"],
                        "url": f"/outputs/{project_id}/{filename}",
                        "downloadUrl": f"/outputs/{project_id}/{filename}",
                        "probe": variant["probe"],
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
                }
                project["error"] = ""
                project["retryable"] = None

            await asyncio.to_thread(mutate_project, project_id, complete)
            await asyncio.to_thread(
                add_event,
                project_id,
                "成片与画幅质检完成",
                f"{aspect_order[0]} 画幅已包含音频、H.264 画面和已烧录字幕。",
                "done",
                100,
                "delivery",
            )
            await asyncio.to_thread(
                add_message,
                project_id,
                "assistant",
                f"成片完成。我按照需求输出了 {aspect_order[0]} 版本，并检查了时长、分辨率、音频和关键帧。",
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


pipeline = VideoPipeline()
