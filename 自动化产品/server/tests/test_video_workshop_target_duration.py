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


class VideoWorkshopTargetDurationTest(unittest.IsolatedAsyncioTestCase):
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

    def test_short_40_second_narration_is_rejected_before_production(self):
        narration = (
            "在这个什么都讲效率的时代，年轻人开始流行一种新的关系，叫搭子。"
            "不是朋友，也不是同事，而是那个恰好和你想做的事一样的人。"
            "咖啡搭子、饭搭子、健身搭子，一个人可以走得很快，"
            "但两个人能走得更远。百度搭子，帮你找到那个陪你一起出发的人。"
            "今天，你找搭子了吗？"
        )
        self.assertEqual(round(providers._narration_units(narration)), 108)
        self.assertTrue(
            providers._narration_needs_duration_repair(narration, 40)
        )
        minimum, maximum = providers._narration_unit_bounds(40)
        self.assertEqual((round(minimum), round(maximum)), (178, 238))

    def test_tts_speed_only_makes_natural_small_adjustments(self):
        short_text = "这是一段用于校准的口播。" * 6
        long_text = "这是一段用于校准的口播。" * 30
        self.assertEqual(
            providers._tts_speed_for_target(short_text, 40),
            providers.MIN_NARRATION_SPEED,
        )
        self.assertEqual(
            providers._tts_speed_for_target(long_text, 40),
            providers.MAX_NARRATION_SPEED,
        )
        self.assertEqual(
            providers._tts_speed_for_target(short_text, None),
            providers.DEFAULT_NARRATION_SPEED,
        )

    def test_scene_generation_duration_uses_real_narration_window(self):
        self.assertEqual(pipeline._scene_generation_duration(3.2), 4)
        self.assertEqual(pipeline._scene_generation_duration(8.01), 9)
        self.assertTrue(pipeline._clip_covers_target(7.9, 8.0))
        self.assertFalse(pipeline._clip_covers_target(7.8, 8.0))
        with self.assertRaisesRegex(RuntimeError, "Seedance 15 秒上限"):
            pipeline._scene_generation_duration(15.4)

    async def test_media_rejects_materially_short_clip_instead_of_long_freeze(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(media.MediaError, "长时间静止尾帧"):
                await media._normalize_clip(
                    root / "scene.mp4",
                    root / "normalized.mp4",
                    720,
                    1280,
                    8.0,
                    source_duration=7.4,
                )

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
                    target_duration_sec=40,
                )
            self.assertTrue(output.is_file())
        self.assertEqual(captured["voice_setting"]["speed"], result["speed"])
        self.assertGreaterEqual(result["speed"], providers.MIN_NARRATION_SPEED)
        self.assertLessEqual(result["speed"], providers.MAX_NARRATION_SPEED)
        self.assertEqual(result["targetDurationMs"], 40000)

    def test_pipeline_keeps_uploaded_audio_as_the_main_timeline(self):
        source = (
            VIDEO_WORKSHOP_DIR / "app" / "pipeline.py"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'if not narration_source and str(plan.get("input_mode") or "") == "topic"',
            source,
        )
        self.assertIn(
            "normalize_narration(narration_source, narration_path)",
            source,
        )
        self.assertIn("避免用静音或异常语速补足", source)

    def test_media_timeline_uses_the_validated_speech_duration(self):
        self.assertFalse(
            pipeline._generated_narration_matches_target(24.696, 40)
        )
        self.assertTrue(
            pipeline._generated_narration_matches_target(38.2, 40)
        )
        timeline, transition = build_scene_timeline(
            [5, 8, 7, 8, 7, 5],
            39.4,
        )
        self.assertGreater(transition, 0)
        self.assertAlmostEqual(timeline[0]["start"], 0.0, places=6)
        self.assertAlmostEqual(timeline[-1]["end"], 39.4, places=6)
        self.assertAlmostEqual(
            sum(item["duration"] for item in timeline)
            - transition * (len(timeline) - 1),
            39.4,
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
                patch.object(pipeline.bgm_library, "resolve", return_value=None),
                patch.object(pipeline.openmontage, "validate_composition", return_value={"success": True}),
                patch.object(pipeline.openmontage, "inspect_video", return_value={"success": True}),
                patch.object(pipeline, "mutate_project", side_effect=mutate),
                patch.object(pipeline, "add_event"),
                patch.object(pipeline, "add_message"),
            ):
                await pipeline.VideoPipeline().run(project["id"], plan)

            self.assertEqual(submitted, [6, 6])
            self.assertLess(order.index("probe-narration"), order.index("scene-1"))
            self.assertEqual(project["status"], "succeeded")

    async def test_selective_scene_failure_keeps_previous_clip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outputs_dir = root / "outputs"
            uploads_dir = root / "uploads"
            work_dir = outputs_dir / "selective"
            work_dir.mkdir(parents=True)
            uploads_dir.mkdir()
            (work_dir / "narration.mp3").write_bytes(b"narration")
            old_scene = work_dir / "scene-01.mp4"
            old_scene.write_bytes(b"previous-valid-scene")
            project = {"id": "selective", "messages": [], "deliveries": [], "outputs": []}

            def mutate(_project_id, callback):
                callback(project)
                return project

            async def fake_probe(path):
                return {"duration": 8.0 if Path(path).name == "narration.mp3" else 7.0}

            async def generate_scene(_prompt, _ratio, output_path, **_kwargs):
                Path(output_path).write_bytes(b"too-short-candidate")
                return {"path": str(output_path)}

            generated = AsyncMock(side_effect=generate_scene)
            plan = {
                "title": "单镜头事务测试",
                "narration": "保留原口播。",
                "input_mode": "script",
                "aspect_ratio": "9:16",
                "scenes": [{"duration_sec": 8, "visual_prompt": "修改后的镜头"}],
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
                patch.object(pipeline.bgm_library, "resolve", return_value=None),
                patch.object(pipeline, "mutate_project", side_effect=mutate),
                patch.object(pipeline, "add_event"),
                patch.object(pipeline, "add_message"),
            ):
                await pipeline.VideoPipeline().run(project["id"], plan, retry_scene_number=1)

            self.assertEqual(generated.await_count, 2)
            self.assertEqual(old_scene.read_bytes(), b"previous-valid-scene")
            self.assertFalse(list(work_dir.glob("*.candidate.mp4")))
            self.assertEqual(project["status"], "failed")


if __name__ == "__main__":
    unittest.main()
