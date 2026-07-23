from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from app import main, providers


ROOT = Path(__file__).resolve().parents[1]


class VoiceIdParsingTests(unittest.TestCase):
    def test_chat_request_accepts_voice_id(self):
        request = main.ChatRequest(message="做一条产品片", voiceId="designed_voice_123")
        self.assertEqual(request.voiceId, "designed_voice_123")

    def test_explicit_chinese_voice_id_overrides_request_field(self):
        request = main.ChatRequest(
            message="做一条产品片，音色ID：designed_voice_456",
            voiceId="picker_voice_123",
        )
        self.assertEqual(
            main._selected_voice_id(request, {}),
            "designed_voice_456",
        )

    def test_explicit_voice_id_supports_quoted_values(self):
        request = main.ChatRequest(
            message='voice_id="French_Female_News Anchor"',
        )
        self.assertEqual(
            main._selected_voice_id(request, {}),
            "French_Female_News Anchor",
        )

    def test_existing_project_voice_is_reused(self):
        request = main.ChatRequest(message="继续完成")
        project = {"voiceId": "saved_voice", "plan": {"voice_id": "older_voice"}}
        self.assertEqual(main._selected_voice_id(request, project), "saved_voice")

    def test_ordinary_english_voice_word_is_not_misread_as_an_id(self):
        request = main.ChatRequest(message="Keep the brand voice identity consistent")
        self.assertEqual(
            main._selected_voice_id(request, {"voiceId": "default_voice"}),
            "default_voice",
        )

    def test_voice_id_directive_is_not_forwarded_as_director_content(self):
        self.assertEqual(
            main._message_without_voice_id_directive(
                "做一条产品片，音色ID：designed_voice_456"
            ),
            "做一条产品片",
        )
        self.assertEqual(
            main._message_without_voice_id_directive("voice_id=designed_voice_456"),
            "请使用已指定音色按当前上下文继续制作",
        )

    def test_all_historical_user_voice_id_directives_are_removed(self):
        messages = [
            {
                "role": "user",
                "content": "第一轮主题，音色ID：old_designed_voice",
            },
            {"role": "assistant", "content": "请补充时长"},
            {
                "role": "user",
                "content": "30 秒，voice_id=new_designed_voice",
            },
        ]
        cleaned = main._director_messages_without_voice_id_directives(messages)
        self.assertEqual(cleaned[0]["content"], "第一轮主题")
        self.assertEqual(cleaned[1]["content"], "请补充时长")
        self.assertEqual(cleaned[2]["content"], "30 秒")
        self.assertEqual(messages[0]["content"], "第一轮主题，音色ID：old_designed_voice")

    def test_unsafe_voice_id_is_rejected(self):
        request = main.ChatRequest(message="做一条产品片", voiceId="bad/id")
        with self.assertRaisesRegex(ValueError, "不支持的字符"):
            main._selected_voice_id(request, {})


class MiniMaxVoiceIdTests(unittest.TestCase):
    def test_provider_sends_exact_voice_and_group_id(self):
        captured = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["payload"] = json.loads(request.content.decode("utf-8"))
            captured["group_id"] = request.url.params.get("GroupId")
            return httpx.Response(
                200,
                json={
                    "base_resp": {"status_code": 0},
                    "data": {"audio": "494433"},
                    "extra_info": {"audio_length": 1200},
                },
                request=request,
            )

        def client_factory(_timeout, follow_redirects=False):
            return httpx.AsyncClient(transport=httpx.MockTransport(handler))

        test_settings = SimpleNamespace(
            minimax_api_key="configured",
            minimax_base_url="https://tts.invalid",
            minimax_group_id="group-voice-test",
            minimax_tts_model="speech-2.8-hd",
            minimax_voice_id="default_voice_must_not_be_used",
        )
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "voice.mp3"
            with (
                patch.object(providers, "settings", test_settings),
                patch.object(providers, "_client", client_factory),
            ):
                result = asyncio.run(
                    providers.MiniMaxTTS().generate(
                        "测试指定音色",
                        output,
                        voice_id="designed_voice_exact",
                    )
                )
            self.assertTrue(output.is_file())

        self.assertEqual(
            captured["payload"]["voice_setting"]["voice_id"],
            "designed_voice_exact",
        )
        self.assertEqual(captured["group_id"], "group-voice-test")
        self.assertEqual(result["voiceId"], "designed_voice_exact")

    def test_provider_does_not_retry_with_default_voice(self):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(
                400,
                json={"detail": "voice_id not found"},
                request=request,
            )

        def client_factory(_timeout, follow_redirects=False):
            return httpx.AsyncClient(transport=httpx.MockTransport(handler))

        test_settings = SimpleNamespace(
            minimax_api_key="configured",
            minimax_base_url="https://tts.invalid",
            minimax_group_id="group-voice-test",
            minimax_tts_model="speech-2.8-hd",
            minimax_voice_id="default_voice",
        )
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(providers, "settings", test_settings),
                patch.object(providers, "_client", client_factory),
            ):
                with self.assertRaisesRegex(providers.ProviderError, "voice_id not found"):
                    asyncio.run(
                        providers.MiniMaxTTS().generate(
                            "测试不回退",
                            Path(tmp) / "voice.mp3",
                            voice_id="missing_voice",
                        )
                    )

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["voice_setting"]["voice_id"], "missing_voice")

    def test_voice_smoke_endpoint_echoes_actual_voice_id(self):
        generated = AsyncMock(
            return_value={"voiceId": "designed_voice_smoke", "durationMs": 900}
        )
        test_settings = SimpleNamespace(
            outputs_dir=Path("/tmp"),
            minimax_voice_id="default_voice",
        )
        with (
            patch.object(main, "settings", test_settings),
            patch.object(main.tts, "generate", generated),
        ):
            result = asyncio.run(
                main.test_voice(main.VoiceTestRequest(voiceId="designed_voice_smoke"))
            )

        self.assertEqual(result["voiceId"], "designed_voice_smoke")
        self.assertEqual(
            generated.await_args.kwargs["voice_id"],
            "designed_voice_smoke",
        )


class VoiceIdPipelineWiringTests(unittest.TestCase):
    def test_plan_and_pipeline_keep_the_selected_voice_id(self):
        main_source = (ROOT / "app" / "main.py").read_text(encoding="utf-8")
        pipeline_source = (ROOT / "app" / "pipeline.py").read_text(encoding="utf-8")
        self.assertIn('plan["voice_id"] = selected_voice_id', main_source)
        self.assertIn(
            'voice_id=str(plan.get("voice_id") or "").strip() or None',
            pipeline_source,
        )

    def test_group_id_is_documented_in_example_environment(self):
        env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("MINIMAX_GROUP_ID=", env_example)
        self.assertTrue(hasattr(providers.settings, "minimax_group_id"))


class VoiceIdChatPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_persists_explicit_voice_id_into_the_final_plan(self):
        project = {
            "id": "project-voice-test",
            "name": "新会话",
            "status": "draft",
            "messages": [],
            "events": [],
            "assets": [],
        }

        def mutate(_project_id, callback):
            callback(project)
            return project

        decision = {
            "action": "generate",
            "plan": {
                "title": "音色透传测试",
                "narration": "这是一段测试口播。",
                "aspect_ratio": "9:16",
                "scenes": [
                    {
                        "duration_sec": 5,
                        "visual_prompt": "简洁的产品画面",
                    }
                ],
            },
        }
        with (
            patch.object(main, "create_project", return_value=project),
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main, "add_message"),
            patch.object(main, "add_event"),
            patch.object(main.director, "decide", AsyncMock(return_value=decision)),
            patch.object(main.pipeline, "run", AsyncMock()),
        ):
            accepted = await main.chat(
                main.ChatRequest(
                    message="做一条产品片，音色ID：designed_voice_persist",
                )
            )
            self.assertEqual("running", accepted["status"])
            await main._project_tasks["project-voice-test"]
            result = project

        self.assertEqual(result["voiceId"], "designed_voice_persist")
        self.assertEqual(
            result["plan"]["voice_id"],
            "designed_voice_persist",
        )


if __name__ == "__main__":
    unittest.main()
