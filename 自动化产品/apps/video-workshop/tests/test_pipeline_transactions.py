from __future__ import annotations

import asyncio
import importlib
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

pipeline_module = importlib.import_module("app.pipeline")


def _plan(scene_count: int = 1) -> dict:
    return {
        "title": "pipeline transaction test",
        "narration": "transaction test narration",
        "aspect_ratio": "9:16",
        "scenes": [
            {"duration_sec": 4, "visual_prompt": f"scene {index}"}
            for index in range(1, scene_count + 1)
        ],
    }


class PipelineTransactionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.outputs_dir = self.root / "outputs"
        self.uploads_dir = self.root / "uploads"
        self.outputs_dir.mkdir()
        self.uploads_dir.mkdir()
        self.project_id = "transaction-test"
        self.work_dir = self.outputs_dir / self.project_id
        self.project = {
            "id": self.project_id,
            "status": "running",
            "phase": "production",
            "progress": 10,
            "outputs": [],
            "deliveries": [],
            "events": [],
            "messages": [],
        }
        self.settings_patch = patch.object(
            pipeline_module,
            "settings",
            SimpleNamespace(
                outputs_dir=self.outputs_dir,
                uploads_dir=self.uploads_dir,
            ),
        )
        self.settings_patch.start()

    async def asyncTearDown(self) -> None:
        self.settings_patch.stop()
        self.temp.cleanup()

    def _mutate(self, _project_id: str, callback):
        callback(self.project)
        return self.project

    async def _tts_generate(self, _text: str, output: Path, **_kwargs):
        output.write_bytes(b"narration")
        return {"path": str(output)}

    async def _probe(self, path: Path) -> dict:
        return {"duration": 4.0 if path.name == "narration.mp3" else 5.0}

    async def _compose(self, *_args, **kwargs) -> dict:
        output = Path(kwargs.get("work_dir") or _args[4]) / "render.mp4"
        output.write_bytes(b"render")
        return {
            "path": str(output),
            "aspectRatio": "9:16",
            "width": 720,
            "height": 1280,
            "probe": {"duration": 4.0},
            "captionCues": [],
            "materialCues": [],
            "sfxCues": [],
        }

    async def _retime(self, source: Path, output: Path, speed: float) -> dict:
        output.write_bytes(Path(source).read_bytes())
        return {"duration": 3.333, "videoDuration": 3.333, "audioDuration": 3.333, "speed": speed}

    async def _lock_timed_visual_plan(self, plan: dict, narration_duration: float) -> dict:
        """Keep transaction fixtures offline while matching the timed-director contract."""
        return {
            "scenes": [dict(scene) for scene in plan.get("scenes") or []],
            "minimum_units": 1,
            "public_summary": f"transaction fixture for {narration_duration:.1f}s narration",
            "asset_placements": [],
        }

    def _common_patches(self, instance: pipeline_module.VideoPipeline):
        return (
            patch.object(instance, "_event", AsyncMock()),
            patch.object(pipeline_module, "load_project", return_value=self.project),
            patch.object(pipeline_module, "mutate_project", side_effect=self._mutate),
            patch.object(pipeline_module.tts, "generate", new=self._tts_generate),
            patch.object(pipeline_module, "probe", new=self._probe),
            patch.object(pipeline_module, "retime_video", new=self._retime),
            patch.object(pipeline_module.bgm_library, "resolve", return_value=None),
            patch.object(
                pipeline_module.director,
                "lock_timed_visual_plan",
                new=AsyncMock(side_effect=self._lock_timed_visual_plan),
            ),
        )

    async def test_qa_failure_keeps_existing_scene(self) -> None:
        instance = pipeline_module.VideoPipeline()
        self.work_dir.mkdir()
        old_scene = self.work_dir / "scene-01.mp4"
        old_scene.write_bytes(b"old-scene")

        async def generate(_prompt, _aspect, output: Path, **_kwargs):
            output.write_bytes(b"new-scene")
            return {"path": str(output)}

        inspect_video = Mock(return_value={"success": False, "error": "qa failed"})
        with ExitStack() as stack:
            for common_patch in self._common_patches(instance):
                stack.enter_context(common_patch)
            stack.enter_context(patch.object(pipeline_module.seedance, "generate", new=generate))
            stack.enter_context(patch.object(pipeline_module, "compose_variant", new=self._compose))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "validate_composition",
                return_value={"success": True},
            ))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "inspect_video",
                inspect_video,
            ))
            stack.enter_context(patch.object(pipeline_module, "add_event"))
            stack.enter_context(patch.object(pipeline_module, "add_message"))
            await instance.run(self.project_id, _plan())

        self.assertEqual(old_scene.read_bytes(), b"old-scene")
        self.assertEqual(self.project["status"], "failed")
        inspect_video.assert_called_once()
        self.assertEqual(list(self.work_dir.glob("*.candidate.mp4")), [])

    async def test_notification_failure_does_not_undo_committed_delivery(self) -> None:
        instance = pipeline_module.VideoPipeline()
        self.work_dir.mkdir()
        old_scene = self.work_dir / "scene-01.mp4"
        old_scene.write_bytes(b"old-scene")

        async def generate(_prompt, _aspect, output: Path, **_kwargs):
            output.write_bytes(b"new-scene")
            return {"path": str(output)}

        add_event = Mock(side_effect=RuntimeError("event unavailable"))
        add_message = Mock(side_effect=RuntimeError("message unavailable"))
        with ExitStack() as stack:
            for common_patch in self._common_patches(instance):
                stack.enter_context(common_patch)
            stack.enter_context(patch.object(pipeline_module.seedance, "generate", new=generate))
            stack.enter_context(patch.object(pipeline_module, "compose_variant", new=self._compose))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "validate_composition",
                return_value={"success": True},
            ))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "inspect_video",
                return_value={"success": True},
            ))
            stack.enter_context(patch.object(pipeline_module, "add_event", add_event))
            stack.enter_context(patch.object(pipeline_module, "add_message", add_message))
            await instance.run(self.project_id, _plan())

        self.assertEqual(self.project["status"], "succeeded")
        self.assertEqual(self.project["phase"], "delivery")
        self.assertTrue(self.project["outputs"])
        self.assertEqual(old_scene.read_bytes(), b"new-scene")
        self.assertEqual(add_event.call_count, 1)
        self.assertEqual(add_message.call_count, 1)
        self.assertEqual(list(self.work_dir.glob("*.candidate.mp4")), [])
        self.assertEqual(list(self.work_dir.glob(".*.backup")), [])

    async def test_selected_platform_bgm_reaches_compose_and_delivery(self) -> None:
        instance = pipeline_module.VideoPipeline()
        selected_path = self.root / "shared-bgm.mp3"
        selected_path.write_bytes(b"shared-bgm")
        selected_bgm = SimpleNamespace(
            id="platform:bgm-test",
            name="共享测试配乐",
            path=selected_path,
            source="platform",
        )
        compose_calls = []

        async def generate(_prompt, _aspect, output: Path, **_kwargs):
            output.write_bytes(b"new-scene")
            return {"path": str(output)}

        async def compose_with_bgm(*args, **kwargs):
            compose_calls.append({
                "bgm_path": kwargs.get("bgm_path"),
                "bgm_volume": kwargs.get("bgm_volume"),
            })
            return await self._compose(*args, **kwargs)

        plan = _plan()
        plan["audio_design"] = {
            "bgm_enabled": True,
            "bgm_track_id": selected_bgm.id,
            "bgm_volume": 0.18,
        }
        with ExitStack() as stack:
            for common_patch in self._common_patches(instance):
                stack.enter_context(common_patch)
            stack.enter_context(patch.object(
                pipeline_module.bgm_library,
                "resolve",
                return_value=selected_bgm,
            ))
            stack.enter_context(patch.object(pipeline_module.seedance, "generate", new=generate))
            stack.enter_context(patch.object(pipeline_module, "compose_variant", new=compose_with_bgm))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "validate_composition",
                return_value={"success": True},
            ))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "inspect_video",
                return_value={"success": True},
            ))
            stack.enter_context(patch.object(pipeline_module, "add_event"))
            stack.enter_context(patch.object(pipeline_module, "add_message"))
            await instance.run(self.project_id, plan)

        self.assertEqual(
            [{"bgm_path": selected_path, "bgm_volume": 0.18}],
            compose_calls,
        )
        self.assertEqual("platform:bgm-test", self.project["production"]["bgm"]["id"])
        self.assertEqual("platform", self.project["production"]["bgm"]["source"])
        self.assertEqual("platform:bgm-test", self.project["outputs"][0]["bgm"]["id"])

    async def test_static_mode_generates_images_in_parallel_with_every_turn_reference(self) -> None:
        instance = pipeline_module.VideoPipeline()
        upload_dir = self.uploads_dir / self.project_id
        upload_dir.mkdir()
        for name in ("ip.png", "logo.png"):
            (upload_dir / name).write_bytes(b"\x89PNG\r\n\x1a\nreference")

        plan = _plan(scene_count=3)
        plan.update({
            "creation_mode": "static",
            "aspect_ratio": "16:9",
            "style_anchor": "统一柔和纸雕风，暖白背景，蓝橙固定配色",
            "negative_constraints": "不换画风，不生成字幕，不改变IP身份",
            "reference_images": [
                {
                    "asset_id": "ip",
                    "label": "图1",
                    "mime": "image/png",
                    "url": f"/uploads/{self.project_id}/ip.png",
                },
                {
                    "asset_id": "logo",
                    "label": "图2",
                    "mime": "image/png",
                    "url": f"/uploads/{self.project_id}/logo.png",
                },
            ],
        })
        for index, scene in enumerate(plan["scenes"], start=1):
            scene["image_prompt"] = f"静态图片分镜 {index}"
            scene["reference_labels"] = ["图1"] if index == 1 else []

        active = 0
        peak = 0
        image_calls: list[dict] = []
        still_calls: list[dict] = []

        async def generate_image(prompt, aspect_ratio, output: Path, **kwargs):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            image_calls.append({
                "prompt": prompt,
                "aspect_ratio": aspect_ratio,
                "reference_images": list(kwargs.get("reference_images") or []),
                "scene_number": kwargs.get("scene_number"),
            })
            await asyncio.sleep(0.01)
            output.write_bytes(b"\xff\xd8\xffstatic-image")
            active -= 1
            return {"path": str(output)}

        async def render_still(source: Path, output: Path, aspect_ratio: str, duration: float):
            still_calls.append({
                "source": source,
                "aspect_ratio": aspect_ratio,
                "duration": duration,
            })
            output.write_bytes(b"static-video-clip")
            return {"duration": duration}

        seedance_generate = AsyncMock()
        with ExitStack() as stack:
            for common_patch in self._common_patches(instance):
                stack.enter_context(common_patch)
            stack.enter_context(patch.object(
                pipeline_module.image_generator,
                "generate",
                new=generate_image,
            ))
            stack.enter_context(patch.object(
                pipeline_module,
                "render_still_clip",
                new=render_still,
            ))
            stack.enter_context(patch.object(
                pipeline_module.seedance,
                "generate",
                seedance_generate,
            ))
            stack.enter_context(patch.object(
                pipeline_module,
                "compose_variant",
                new=self._compose,
            ))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "validate_composition",
                return_value={"success": True},
            ))
            stack.enter_context(patch.object(
                pipeline_module.openmontage,
                "inspect_video",
                return_value={"success": True},
            ))
            stack.enter_context(patch.object(pipeline_module, "add_event"))
            stack.enter_context(patch.object(pipeline_module, "add_message"))
            await instance.run(self.project_id, plan)

        self.assertEqual(3, len(image_calls))
        self.assertEqual(3, len(still_calls))
        self.assertGreaterEqual(peak, 2)
        for call in image_calls:
            self.assertEqual("16:9", call["aspect_ratio"])
            self.assertEqual(["图1", "图2"], [
                item["label"] for item in call["reference_images"]
            ])
            self.assertIn("统一柔和纸雕风", call["prompt"])
            self.assertIn("不换画风", call["prompt"])
            self.assertIn("用于 16:9 静态视频分镜", call["prompt"])
        seedance_generate.assert_not_awaited()
        self.assertEqual("succeeded", self.project["status"])
        self.assertEqual("static", self.project["plan"]["creation_mode"])

    async def test_static_image_empty_response_retries_without_restarting_project(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        output = self.work_dir / "retry.jpg"
        calls = 0
        progress: list[str] = []

        async def flaky_generate(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls < 3:
                raise pipeline_module.ProviderError("静态分镜 2 未返回图片")
            output.write_bytes(b"\xff\xd8\xffsuccessful-static-image")
            return {"path": str(output)}

        async def callback(title, _detail, _progress):
            progress.append(title)

        with (
            patch.object(pipeline_module.image_generator, "generate", new=flaky_generate),
            patch.object(pipeline_module.asyncio, "sleep", new=AsyncMock()),
        ):
            result = await pipeline_module._generate_static_image_with_retry(
                prompt="静态图片",
                aspect_ratio="16:9",
                output_path=output,
                reference_images=[],
                callback=callback,
                scene_number=2,
            )

        self.assertEqual(3, calls)
        self.assertEqual(str(output), result["path"])
        self.assertEqual(
            ["静态分镜 2 正在自动重试", "静态分镜 2 正在自动重试"],
            progress,
        )

    async def test_director_continuity_anchor_is_generated_once_and_reused_by_every_scene(self) -> None:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        reference = self.work_dir / "user.png"
        reference.write_bytes(b"\x89PNG\r\n\x1a\nuser-reference")
        calls: list[dict] = []

        async def generate(**kwargs):
            calls.append(kwargs)
            Path(kwargs["output_path"]).write_bytes(b"\xff\xd8\xffcontinuity-anchor")
            return {"path": str(kwargs["output_path"])}

        plan = {
            "style_anchor": "统一日系漫画线稿与蓝橙配色",
            "negative_constraints": "角色身份不漂移",
            "continuity_anchors": [{
                "key": "host",
                "kind": "character",
                "description": "短发、蓝色外套的同一位女性主持人",
                "reason": "主持人贯穿全片",
            }],
        }
        user_references = [{"label": "图1", "path": str(reference)}]
        with patch.object(
            pipeline_module,
            "_generate_static_image_with_retry",
            new=generate,
        ):
            first = await pipeline_module._ensure_static_continuity_references(
                project_id=self.project_id,
                plan=plan,
                work_dir=self.work_dir,
                user_references=user_references,
                callback=None,
            )
            second = await pipeline_module._ensure_static_continuity_references(
                project_id=self.project_id,
                plan=plan,
                work_dir=self.work_dir,
                user_references=user_references,
                callback=None,
            )

        self.assertEqual(1, len(calls))
        self.assertEqual(["图1", "连续性锚点1"], [item["label"] for item in first])
        self.assertEqual(["图1", "连续性锚点1"], [item["label"] for item in second])

    async def test_failed_candidate_cancels_and_reaps_siblings_before_cleanup(self) -> None:
        instance = pipeline_module.VideoPipeline()
        slow_started = asyncio.Event()
        slow_reaped = asyncio.Event()

        async def probe_two_scene_timeline(path: Path) -> dict:
            # Keep both logical scenes in the render queue; a four-second
            # narration can legitimately collapse this synthetic fixture into
            # one technical unit before the cancellation behavior is reached.
            return {"duration": 8.0 if path.name == "narration.mp3" else 5.0}

        timed_scenes = [
            {
                "title": f"镜头 {index}",
                "duration_sec": 4,
                "visual_prompt": f"scene {index}",
                "narration_excerpt": "transaction " if index == 1 else "test narration",
                "visual_beats": [],
                "purpose": "test cancellation",
            }
            for index in (1, 2)
        ]

        async def generate(_prompt, _aspect, output: Path, *, scene_number: int, **_kwargs):
            output.write_bytes(f"candidate-{scene_number}".encode())
            if scene_number == 1:
                slow_started.set()
                try:
                    await asyncio.Future()
                finally:
                    slow_reaped.set()
                return {"path": str(output)}
            await slow_started.wait()
            raise RuntimeError("candidate failed")

        with ExitStack() as stack:
            for common_patch in self._common_patches(instance):
                stack.enter_context(common_patch)
            stack.enter_context(patch.object(pipeline_module, "probe", new=probe_two_scene_timeline))
            stack.enter_context(patch.object(
                pipeline_module.director,
                "lock_timed_visual_plan",
                AsyncMock(return_value={
                    "scenes": timed_scenes,
                    "minimum_units": 2,
                    "public_summary": "two-scene cancellation fixture",
                    "asset_placements": [],
                }),
            ))
            stack.enter_context(patch.object(pipeline_module.seedance, "generate", new=generate))
            stack.enter_context(patch.object(pipeline_module, "add_event"))
            stack.enter_context(patch.object(pipeline_module, "add_message"))
            await instance.run(self.project_id, _plan(scene_count=2))

        self.assertTrue(slow_reaped.is_set())
        self.assertEqual(self.project["status"], "failed")
        self.assertEqual(list(self.work_dir.glob("*.candidate.mp4")), [])
        remaining = [
            task
            for task in asyncio.all_tasks()
            if task is not asyncio.current_task() and not task.done()
        ]
        self.assertEqual(remaining, [])

    async def test_speed_version_uses_preserved_source_without_regenerating(self) -> None:
        instance = pipeline_module.VideoPipeline()
        self.work_dir.mkdir()
        source_path = self.work_dir / "delivery-source.mp4"
        source_path.write_bytes(b"original-render")
        self.project["status"] = "succeeded"
        self.project["deliveries"] = [
            {
                "id": "delivery-old",
                "outputs": [
                    {
                        "id": "output-old",
                        "deliveryId": "delivery-old",
                        "aspectRatio": "9:16",
                        "url": f"/outputs/{self.project_id}/delivery-fast.mp4",
                        "retimeSourceUrl": f"/outputs/{self.project_id}/{source_path.name}",
                        "probe": {"duration": 8.0},
                    }
                ],
            }
        ]

        async def retime(source: Path, output: Path, speed: float) -> dict:
            self.assertEqual(source, source_path.resolve())
            self.assertEqual(speed, 1.5)
            output.write_bytes(source.read_bytes())
            return {"duration": 5.333, "videoDuration": 5.333, "audioDuration": 5.333}

        with (
            patch.object(pipeline_module, "load_project", return_value=self.project),
            patch.object(pipeline_module, "mutate_project", side_effect=self._mutate),
            patch.object(pipeline_module, "retime_video", new=retime),
            patch.object(pipeline_module, "add_message") as add_message,
            patch.object(pipeline_module.seedance, "generate", AsyncMock()) as generate,
            patch.object(pipeline_module.tts, "generate", AsyncMock()) as tts_generate,
        ):
            output = await instance.create_speed_version(self.project_id, "output-old", 1.5)

        self.assertEqual(output["speed"], 1.5)
        self.assertTrue((self.work_dir / Path(output["url"]).name).is_file())
        generate.assert_not_awaited()
        tts_generate.assert_not_awaited()
        add_message.assert_called_once()


if __name__ == "__main__":
    unittest.main()
