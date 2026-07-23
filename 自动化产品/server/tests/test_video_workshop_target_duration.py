import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx


APP_DIR = Path(__file__).resolve().parents[2]
VIDEO_WORKSHOP_DIR = APP_DIR / "apps" / "video-workshop"
if str(VIDEO_WORKSHOP_DIR) not in sys.path:
    sys.path.insert(0, str(VIDEO_WORKSHOP_DIR))

from app import media, pipeline, providers
from app.media import build_scene_timeline


async def fake_retime_video(source, output, speed):
    Path(output).write_bytes(Path(source).read_bytes())
    return {"duration": 8.0, "videoDuration": 8.0, "audioDuration": 8.0, "speed": speed}


class VideoWorkshopTargetDurationTest(unittest.IsolatedAsyncioTestCase):
    def test_director_pacing_guidance_is_explicitly_optional(self):
        prompt = providers.MiniMaxDirector()._system_prompt(
            "9:16",
            "",
            [],
        )
        self.assertIn("先做叙事镜头计划，再做内部剪辑决定", prompt)
        self.assertIn("不按固定数量、固定秒数或等间隔凑数", prompt)
        self.assertIn("一个技术片段可以通过清晰的时间结构包含多次内部镜头变化", prompt)
        self.assertNotIn("约 2 到 4 秒", prompt)
        self.assertNotIn("一句口播两个镜头", prompt)

    def test_seedance_pacing_hint_only_applies_to_longer_render_units(self):
        with tempfile.TemporaryDirectory() as tmp:
            units = pipeline._render_units(
                [
                    {"visual_prompt": "人物在桌面操作工具"},
                    {"visual_prompt": "人物停下思考"},
                ],
                [
                    {"sceneNumber": 1, "duration": 12.0},
                    {"sceneNumber": 2, "duration": 6.0},
                ],
                Path(tmp),
            )
        fast_hint = units[0]["scene"]["visual_prompt"]
        short_hint = units[1]["scene"]["visual_prompt"]
        self.assertIn("剪辑判断（非硬性）", fast_hint)
        self.assertIn("列举、反差、动作、证据与情绪转折", fast_hint)
        self.assertIn("不要等间隔切换", fast_hint)
        self.assertNotIn("剪辑判断（非硬性）", short_hint)

    def test_long_logical_scene_uses_distinct_render_units(self):
        timeline, _ = build_scene_timeline([1], 40.0)
        with tempfile.TemporaryDirectory() as tmp:
            units = pipeline._render_units(
                [{"visual_prompt": "一个人物沿着走廊向前"}],
                timeline,
                Path(tmp),
            )
        self.assertGreater(len(units), 1)
        self.assertEqual(len({str(item["target_path"]) for item in units}), len(units))
        self.assertTrue(all("独立视觉节拍" in item["scene"]["visual_prompt"] for item in units))
        self.assertTrue(all("不要复用" in item["scene"]["visual_prompt"] for item in units))

    async def test_seedance_queue_never_exceeds_ten_active_jobs(self):
        active = 0
        maximum = 0
        gate = asyncio.Event()

        async def job():
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            if maximum >= 10:
                gate.set()
            await gate.wait()
            await asyncio.sleep(0)
            active -= 1

        await pipeline._gather_bounded(*(job() for _ in range(24)), limit=10)
        self.assertEqual(maximum, 10)

    async def test_final_retime_changes_audio_and_video_together(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.mp4"
            source.write_bytes(b"video")
            with (
                patch.object(media, "run", AsyncMock()) as run,
                patch.object(
                    media,
                    "probe",
                    AsyncMock(return_value={"duration": 10.0, "videoDuration": 10.0, "audioDuration": 10.0}),
                ),
            ):
                await media.retime_video(source, root / "speed.mp4", 1.2)
        command = run.await_args.args[0]
        graph = command[command.index("-filter_complex") + 1]
        self.assertIn("setpts=PTS/1.200000", graph)
        self.assertIn("atempo=1.200000", graph)

    def test_explicit_duration_parser_ignores_script_timeline_ranges(self):
        self.assertEqual(
            providers._explicit_duration_seconds(
                [{"role": "user", "content": "以这个为主题创作一条40s"}]
            ),
            40,
        )
        self.assertEqual(
            providers._explicit_duration_seconds(
                [{"role": "user", "content": "总时长控制在 30 秒"}]
            ),
            30,
        )
        self.assertIsNone(
            providers._explicit_duration_seconds(
                [
                    {
                        "role": "user",
                        "content": "0-2s 开场，3-6s 产品特写，7-9s 收尾",
                    }
                ]
            )
        )

    def test_requested_duration_is_metadata_not_a_hard_narration_gate(self):
        source = (VIDEO_WORKSHOP_DIR / "app" / "providers.py").read_text(encoding="utf-8")
        self.assertNotIn("_repair_narration_duration", source)
        self.assertNotIn("duration_sec 必须填写", source)
        self.assertIn("不要套用固定镜头数量或固定拆句公式", source)

    def test_tts_uses_natural_speed_without_duration_forcing(self):
        short_text = "这是一段用于校准的口播。" * 6
        long_text = "这是一段用于校准的口播。" * 30
        self.assertEqual(providers._tts_speed_for_target(short_text, 40), 1.0)
        self.assertEqual(providers._tts_speed_for_target(long_text, 40), 1.0)
        self.assertEqual(
            providers._tts_speed_for_target(short_text, None),
            1.0,
        )

    def test_scene_generation_duration_uses_real_narration_window(self):
        self.assertEqual(pipeline._scene_generation_duration(3.2), 4)
        self.assertEqual(pipeline._scene_generation_duration(8.01), 9)
        self.assertTrue(pipeline._clip_covers_target(7.9, 8.0))
        self.assertTrue(pipeline._clip_covers_target(7.8, 8.0))
        self.assertEqual(pipeline._scene_generation_duration(15.4), 15)

    async def test_media_retimes_short_clip_without_static_tail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.object(media, "run", AsyncMock()) as run:
                await media._normalize_clip(
                    root / "scene.mp4",
                    root / "normalized.mp4",
                    720,
                    1280,
                    8.0,
                    source_duration=7.4,
                )
        command = run.await_args.args[0]
        filter_graph = command[command.index("-vf") + 1]
        self.assertIn("setpts=1.08108108*(PTS-STARTPTS)", filter_graph)
        self.assertNotIn("tpad=stop_mode=clone", filter_graph)

    async def test_tts_payload_receives_target_aware_speed(self):
        captured = {}

        def handler(request):
            captured.update(json.loads(request.content.decode("utf-8")))
            return httpx.Response(
                200,
                json={
                    "base_resp": {"status_code": 0},
                    "data": {"audio": "494433"},
                    "extra_info": {"audio_length": 39800},
                },
                request=request,
            )

        def client_factory(_timeout, follow_redirects=False):
            return httpx.AsyncClient(transport=httpx.MockTransport(handler))

        text = "这是一段自然完整的中文口播，包含背景、场景、转折和结论。" * 7
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "narration.mp3"
            with (
                patch.object(
                    providers,
                    "settings",
                    SimpleNamespace(
                        minimax_api_key="configured",
                        minimax_tts_model="speech-2.8-hd",
                        minimax_voice_id="voice-id",
                        minimax_base_url="https://tts.invalid",
                    ),
                ),
                patch.object(providers, "_client", client_factory),
            ):
                result = await providers.MiniMaxTTS().generate(
                    text,
                    output,
                    target_duration_sec=None,
                )
            self.assertTrue(output.is_file())
        self.assertEqual(captured["voice_setting"]["speed"], result["speed"])
        self.assertEqual(result["speed"], 1.0)
        self.assertEqual(result["targetDurationMs"], 0)

    def test_pipeline_keeps_uploaded_audio_as_the_main_timeline(self):
        source = (
            VIDEO_WORKSHOP_DIR / "app" / "pipeline.py"
        ).read_text(encoding="utf-8")
        self.assertIn(
            "normalize_narration(narration_source, narration_path)",
            source,
        )
        self.assertIn("target_duration_sec=None", source)
        self.assertNotIn("与用户要求的", source)

    def test_media_timeline_uses_measured_speech_and_rebalances_long_scene(self):
        timeline, transition = build_scene_timeline(
            [15, 8, 8, 8, 8, 6, 5],
            58.0,
        )
        self.assertGreaterEqual(transition, 0)
        self.assertAlmostEqual(timeline[0]["start"], 0.0, places=6)
        self.assertAlmostEqual(timeline[-1]["end"], 58.0, places=6)
        self.assertLessEqual(max(item["duration"] for item in timeline), 18.0)
        self.assertTrue(
            all(
                pipeline._scene_generation_duration(item["duration"]) <= 15
                for item in timeline
            )
        )
        self.assertAlmostEqual(
            sum(item["duration"] for item in timeline)
            - transition * (len(timeline) - 1),
            58.0,
            places=5,
        )

    def test_over_limit_window_is_split_without_changing_the_director_scene(self):
        timeline, transition = build_scene_timeline([1], 16.1)
        self.assertEqual(len(timeline), 2)
        self.assertGreater(transition, 0)
        self.assertTrue(all(item["sourceSceneNumber"] == 1 for item in timeline))
        self.assertLessEqual(max(item["duration"] for item in timeline), 15.0)

    def test_very_long_window_is_split_only_as_a_backend_fallback(self):
        timeline, transition = build_scene_timeline([1], 40.0)
        self.assertGreater(len(timeline), 1)
        self.assertLessEqual(max(item["duration"] for item in timeline), 15.0)
        self.assertAlmostEqual(
            sum(item["duration"] for item in timeline)
            - transition * (len(timeline) - 1),
            40.0,
            places=5,
        )

    async def test_pipeline_probes_narration_before_submitting_scene_durations(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outputs_dir = root / "outputs"
            uploads_dir = root / "uploads"
            outputs_dir.mkdir()
            uploads_dir.mkdir()
            project = {"id": "audio-first", "messages": [], "deliveries": [], "outputs": []}
            order: list[str] = []
            submitted: list[int] = []

            def mutate(_project_id, callback):
                callback(project)
                return project

            async def generate_tts(_text, output_path, **_kwargs):
                order.append("tts")
                output_path.write_bytes(b"narration")
                return {"path": str(output_path), "speed": 1.2}

            async def fake_probe(path):
                if Path(path).name == "narration.mp3":
                    order.append("probe-narration")
                    return {"duration": 10.0}
                return {"duration": 6.0}

            async def generate_scene(_prompt, _ratio, output_path, **kwargs):
                self.assertIn("probe-narration", order)
                scene_number = int(kwargs["scene_number"])
                order.append(f"scene-{scene_number}")
                submitted.append(int(kwargs["duration_sec"]))
                Path(output_path).write_bytes(f"scene-{scene_number}".encode())
                return {"path": str(output_path)}

            async def compose(scene_paths, _narration_path, _text, _ratio, work_dir, **_kwargs):
                order.append("compose")
                self.assertTrue(all(Path(path).is_file() for path in scene_paths))
                final = Path(work_dir) / "final-9x16.mp4"
                final.write_bytes(b"final")
                return {
                    "path": final,
                    "aspectRatio": "9:16",
                    "width": 720,
                    "height": 1280,
                    "probe": {"duration": 10.0},
                    "captionCues": [],
                    "materialCues": [],
                    "sfxCues": [],
                }

            plan = {
                "title": "口播优先测试",
                "narration": "先生成口播再安排镜头。",
                "input_mode": "script",
                "aspect_ratio": "9:16",
                "scenes": [
                    {"duration_sec": 5, "visual_prompt": "镜头一"},
                    {"duration_sec": 5, "visual_prompt": "镜头二"},
                ],
                "audio_design": {},
            }
            with (
                patch.object(
                    pipeline,
                    "settings",
                    SimpleNamespace(outputs_dir=outputs_dir, uploads_dir=uploads_dir),
                ),
                patch.object(pipeline, "_ensure_legacy_delivery", return_value=None),
                patch.object(pipeline.tts, "generate", new=generate_tts),
                patch.object(pipeline.seedance, "generate", new=generate_scene),
                patch.object(pipeline, "probe", new=fake_probe),
                patch.object(pipeline, "compose_variant", new=compose),
                patch.object(pipeline, "retime_video", new=fake_retime_video),
                patch.object(pipeline.bgm_library, "resolve", return_value=None),
                patch.object(pipeline.openmontage, "validate_composition", return_value={"success": True}),
                patch.object(pipeline.openmontage, "inspect_video", return_value={"success": True}),
                patch.object(pipeline, "mutate_project", side_effect=mutate),
                patch.object(pipeline, "add_event"),
                patch.object(pipeline, "add_message"),
            ):
                await pipeline.VideoPipeline().run(project["id"], plan)

            # 时序导演可以把 10 秒口播保留为一个有内部镜头变化的技术单元，
            # 也可以拆成多个单元；这里验证生产约束，不把智能节奏重新锁成固定等分。
            self.assertTrue(submitted)
            self.assertTrue(all(4 <= duration <= 15 for duration in submitted))
            self.assertGreaterEqual(sum(submitted), 10)
            self.assertLess(order.index("probe-narration"), order.index("scene-1"))
            self.assertEqual(project["status"], "succeeded")

    async def test_segmented_scene_replacement_stays_transactional(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outputs_dir = root / "outputs"
            uploads_dir = root / "uploads"
            work_dir = outputs_dir / "selective"
            work_dir.mkdir(parents=True)
            uploads_dir.mkdir()
            (work_dir / "narration.mp3").write_bytes(b"narration")
            old_scene = work_dir / "scene-01.mp4"
            old_scene.write_bytes(b"previous-legacy-scene")
            old_parts = [work_dir / f"scene-01-part-{index:02d}.mp4" for index in range(1, 4)]
            for old_part in old_parts:
                old_part.write_bytes(b"previous-valid-scene")
            project = {"id": "selective", "messages": [], "deliveries": [], "outputs": []}

            def mutate(_project_id, callback):
                callback(project)
                return project

            async def fake_probe(path):
                return {"duration": 40.0 if Path(path).name == "narration.mp3" else 15.0}

            async def generate_scene(_prompt, _ratio, output_path, **_kwargs):
                Path(output_path).write_bytes(b"too-short-candidate")
                return {"path": str(output_path)}

            async def compose(scene_paths, _narration_path, _text, _ratio, work_dir, **_kwargs):
                final = Path(work_dir) / "final-9x16.mp4"
                final.write_bytes(b"final")
                return {
                    "path": final,
                    "aspectRatio": "9:16",
                    "width": 720,
                    "height": 1280,
                    "probe": {"duration": 8.0},
                    "captionCues": [],
                    "materialCues": [],
                    "sfxCues": [],
                }

            generated = AsyncMock(side_effect=generate_scene)
            plan = {
                "title": "单镜头事务测试",
                "narration": "保留原口播。",
                "input_mode": "script",
                "aspect_ratio": "9:16",
                "scenes": [{"duration_sec": 1, "visual_prompt": "修改后的镜头"}],
                "audio_design": {},
            }
            with (
                patch.object(
                    pipeline,
                    "settings",
                    SimpleNamespace(outputs_dir=outputs_dir, uploads_dir=uploads_dir),
                ),
                patch.object(pipeline, "_ensure_legacy_delivery", return_value=None),
                patch.object(pipeline.seedance, "generate", generated),
                patch.object(pipeline, "probe", new=fake_probe),
                patch.object(pipeline, "compose_variant", new=compose),
                patch.object(pipeline, "retime_video", new=fake_retime_video),
                patch.object(pipeline.bgm_library, "resolve", return_value=None),
                patch.object(pipeline.openmontage, "validate_composition", return_value={"success": True}),
                patch.object(pipeline.openmontage, "inspect_video", return_value={"success": True}),
                patch.object(pipeline, "mutate_project", side_effect=mutate),
                patch.object(pipeline, "add_event"),
                patch.object(pipeline, "add_message"),
            ):
                await pipeline.VideoPipeline().run(project["id"], plan, retry_scene_number=1)

            self.assertEqual(generated.await_count, 3)
            self.assertEqual(old_scene.read_bytes(), b"previous-legacy-scene")
            self.assertTrue(all(path.read_bytes() == b"too-short-candidate" for path in old_parts))
            self.assertFalse(list(work_dir.glob("*.candidate.mp4")))
            self.assertEqual(project["status"], "succeeded")


if __name__ == "__main__":
    unittest.main()
