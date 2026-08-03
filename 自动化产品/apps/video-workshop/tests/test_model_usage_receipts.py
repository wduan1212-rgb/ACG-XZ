from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import providers, store, usage_receipts


def _project(project_id: str) -> dict:
    return {
        "id": project_id,
        "name": "usage test",
        "status": "running",
        "phase": "production",
        "progress": 10,
        "createdAt": "2026-08-03T10:00:00+08:00",
        "updatedAt": "2026-08-03T10:00:00+08:00",
        "messages": [],
        "events": [],
        "attachments": [],
        "assets": [],
        "plan": None,
        "outputs": [],
        "error": "",
    }


class _Response:
    def __init__(self, status_code: int, payload: dict, headers: dict | None = None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}
        self.text = json.dumps(payload, ensure_ascii=False)

    def json(self):
        return self._payload


class _Client:
    response: _Response
    before_post = None

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, *args, **kwargs):
        if type(self).before_post:
            type(self).before_post()
        return type(self).response


def _client(*args, **kwargs):
    return _Client()


class ModelUsageReceiptTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.projects_dir = Path(self.temp.name)
        self.store_settings = patch.object(
            store,
            "settings",
            SimpleNamespace(projects_dir=self.projects_dir),
        )
        self.store_settings.start()
        store._summary_cache.clear()
        store.save_project(_project("usage-project"))

    def tearDown(self):
        _Client.before_post = None
        store._summary_cache.clear()
        self.store_settings.stop()
        self.temp.cleanup()

    def _receipts(self) -> list[dict]:
        return store.load_project("usage-project").get("modelUsageReceipts") or []

    def test_submitted_receipt_closes_crash_window_and_transitions_idempotently(self):
        with usage_receipts.project_usage_scope("usage-project"):
            operation_id = usage_receipts.new_operation_id("director-plan")
            usage_receipts.record_model_usage_receipt(
                operation_id,
                feature="导演规划",
                usage_kind="llm",
                provider="minimax",
                model="MiniMax-M3",
                status="submitted",
            )
            self.assertEqual("submitted", self._receipts()[0]["status"])
            usage_receipts.record_model_usage_receipt(
                operation_id,
                feature="导演规划",
                usage_kind="llm",
                provider="minimax",
                model="MiniMax-M3",
                status="unknown",
            )
            self.assertEqual("unknown", self._receipts()[0]["status"])
            usage_receipts.record_model_usage_receipt(
                operation_id,
                feature="导演规划",
                usage_kind="llm",
                provider="minimax",
                provider_ref="req-1",
                model="MiniMax-M3",
                status="confirmed",
                input_tokens=12,
                output_tokens=5,
            )
            usage_receipts.record_model_usage_receipt(
                operation_id,
                feature="导演规划",
                usage_kind="llm",
                provider="minimax",
                model="MiniMax-M3",
                status="failed",
            )

            def mark_reconciled(project):
                project["modelUsageReceipts"][0]["reconcileState"] = "reconciled"
                project["modelUsageReceipts"][0]["reconciledAt"] = "2026-08-03T11:00:00+08:00"

            store.mutate_project("usage-project", mark_reconciled)
            usage_receipts.record_model_usage_receipt(
                operation_id,
                feature="导演规划",
                usage_kind="llm",
                provider="minimax",
                provider_ref="req-1",
                model="MiniMax-M3",
                status="succeeded",
                input_tokens=12,
                output_tokens=5,
            )

        receipts = self._receipts()
        self.assertEqual(1, len(receipts))
        self.assertEqual("succeeded", receipts[0]["status"])
        self.assertEqual(17, receipts[0]["totalTokens"])
        self.assertEqual("reconciled", receipts[0]["reconcileState"])
        self.assertNotIn("prompt", json.dumps(receipts, ensure_ascii=False).lower())

    async def test_llm_receipt_is_durable_before_http_and_captures_tokens(self):
        _Client.response = _Response(
            200,
            {
                "id": "llm-response-1",
                "usage": {"prompt_tokens": 31, "completion_tokens": 9},
                "choices": [{"message": {"content": "可以开始"}}],
            },
            {"x-request-id": "llm-request-1"},
        )

        def assert_preflight_receipt():
            receipt = self._receipts()[0]
            self.assertEqual("submitted", receipt["status"])
            self.assertEqual("video-workshop", receipt["surface"])

        _Client.before_post = assert_preflight_receipt
        llm_settings = SimpleNamespace(
            llm_api_key="secret-never-persisted",
            llm_endpoint="https://provider.invalid/v1/chat/completions",
            llm_model="MiniMax-M3",
        )
        with (
            usage_receipts.project_usage_scope("usage-project"),
            patch.object(providers, "_client", _client),
            patch.object(providers, "settings", llm_settings),
        ):
            await providers._post_llm_json_with_retry({"messages": [{"content": "private prompt"}]})

        receipt = self._receipts()[0]
        self.assertEqual("succeeded", receipt["status"])
        self.assertEqual(31, receipt["inputTokens"])
        self.assertEqual(9, receipt["outputTokens"])
        self.assertEqual("llm-request-1", receipt["providerRef"])
        serialized = json.dumps(receipt, ensure_ascii=False)
        self.assertNotIn("private prompt", serialized)
        self.assertNotIn("secret-never-persisted", serialized)

    async def test_image_tts_and_seedance_emit_media_receipts(self):
        image_settings = SimpleNamespace(
            image_api_key="image-secret",
            image_endpoint="https://image.invalid/v1/images/generations",
            image_base_url="https://image.invalid/v1",
            image_model="image-model",
        )
        _Client.before_post = None
        _Client.response = _Response(
            200,
            {"id": "image-1", "data": [{"b64_json": "/9j/c3RpbGw="}]},
        )
        with (
            usage_receipts.project_usage_scope("usage-project"),
            patch.object(providers, "_client", _client),
            patch.object(providers, "settings", image_settings),
        ):
            await providers.GPTImageGenerator().generate(
                "static prompt",
                "16:9",
                self.projects_dir / "still.jpg",
                scene_number=1,
            )

        tts_settings = SimpleNamespace(
            minimax_api_key="tts-secret",
            minimax_voice_id="voice-1",
            minimax_group_id="",
            minimax_tts_model="speech-2.8-hd",
            minimax_base_url="https://tts.invalid",
        )
        _Client.response = _Response(
            200,
            {
                "trace_id": "tts-1",
                "base_resp": {"status_code": 0},
                "data": {"audio": "fffb00"},
                "extra_info": {"audio_length": 1000},
            },
        )
        with (
            usage_receipts.project_usage_scope("usage-project"),
            patch.object(providers, "_client", _client),
            patch.object(providers, "settings", tts_settings),
        ):
            await providers.MiniMaxTTS().generate(
                "三 个 字",
                self.projects_dir / "speech.mp3",
            )

        seedance_settings = SimpleNamespace(
            seedance_api_key="video-secret",
            seedance_base_url="https://seedance.invalid",
            seedance_model="seedance-model",
            seedance_resolution="720p",
        )
        _Client.response = _Response(
            200,
            {"id": "task-1", "video_url": "https://video.invalid/output.mp4"},
        )
        with (
            usage_receipts.project_usage_scope("usage-project"),
            patch.object(providers, "_client", _client),
            patch.object(providers, "settings", seedance_settings),
            patch.object(providers, "_download_seedance_video", AsyncMock()),
        ):
            await providers.SeedanceVideo().generate(
                "dynamic prompt",
                "9:16",
                self.projects_dir / "clip.mp4",
                scene_number=2,
                duration_sec=8,
            )

        by_feature = {item["feature"]: item for item in self._receipts()}
        self.assertEqual("succeeded", by_feature["视频工坊静态分镜"]["status"])
        self.assertEqual(1, by_feature["视频工坊静态分镜"]["outputUnits"])
        self.assertEqual("succeeded", by_feature["视频工坊语音生成"]["status"])
        self.assertEqual(3, by_feature["视频工坊语音生成"]["outputUnits"])
        self.assertEqual("confirmed", by_feature["视频工坊动态视频提交"]["status"])
        self.assertEqual("task-1", by_feature["视频工坊动态视频提交"]["providerRef"])
        self.assertEqual(8, by_feature["视频工坊动态视频提交"]["outputUnits"])

    async def test_http_5xx_remains_unknown_for_every_provider_kind(self):
        _Client.before_post = None
        _Client.response = _Response(503, {"detail": "provider temporarily unavailable"})
        image_settings = SimpleNamespace(
            image_api_key="image-secret",
            image_endpoint="https://image.invalid/v1/images/generations",
            image_base_url="https://image.invalid/v1",
            image_model="image-model",
        )
        llm_settings = SimpleNamespace(
            llm_api_key="llm-secret",
            llm_endpoint="https://llm.invalid/v1/chat/completions",
            llm_model="MiniMax-M3",
        )
        tts_settings = SimpleNamespace(
            minimax_api_key="tts-secret",
            minimax_voice_id="voice-1",
            minimax_group_id="",
            minimax_tts_model="speech-2.8-hd",
            minimax_base_url="https://tts.invalid",
        )
        seedance_settings = SimpleNamespace(
            seedance_api_key="video-secret",
            seedance_base_url="https://seedance.invalid",
            seedance_model="seedance-model",
            seedance_resolution="720p",
        )
        with (
            usage_receipts.project_usage_scope("usage-project"),
            patch.object(providers, "_client", _client),
            patch.object(providers.asyncio, "sleep", new=AsyncMock()),
        ):
            with patch.object(providers, "settings", image_settings):
                with self.assertRaises(providers.ProviderError):
                    await providers.GPTImageGenerator().generate(
                        "static prompt", "16:9", self.projects_dir / "failed-still.jpg"
                    )
            with patch.object(providers, "settings", llm_settings):
                with self.assertRaises(providers.ProviderError):
                    await providers._post_llm_json_with_retry({"messages": []})
            with patch.object(providers, "settings", tts_settings):
                with self.assertRaises(providers.ProviderError):
                    await providers.MiniMaxTTS().generate(
                        "失败口播", self.projects_dir / "failed-speech.mp3"
                    )
            with patch.object(providers, "settings", seedance_settings):
                with self.assertRaises(providers.ProviderError):
                    await providers.SeedanceVideo().generate(
                        "dynamic prompt",
                        "9:16",
                        self.projects_dir / "failed-clip.mp4",
                        scene_number=3,
                        duration_sec=8,
                    )

        receipts = self._receipts()
        self.assertTrue(receipts)
        self.assertEqual(
            {"llm", "image", "voice", "video"},
            {item["usageKind"] for item in receipts},
        )
        self.assertEqual({"unknown"}, {item["status"] for item in receipts})


if __name__ == "__main__":
    unittest.main()
