import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx


APP_DIR = Path(__file__).resolve().parents[2]
VIDEO_WORKSHOP_DIR = APP_DIR / "apps" / "video-workshop"
if str(VIDEO_WORKSHOP_DIR) not in sys.path:
    sys.path.insert(0, str(VIDEO_WORKSHOP_DIR))

from app import pipeline, providers
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
        self.assertEqual((round(minimum), round(maximum)), (148, 198))

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
        self.assertEqual(providers._tts_speed_for_target(short_text, None), 1.0)

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


if __name__ == "__main__":
    unittest.main()
