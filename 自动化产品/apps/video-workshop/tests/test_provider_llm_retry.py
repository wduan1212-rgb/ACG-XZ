import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import providers


class _Response:
    def __init__(self, status_code, payload=None, text="", headers=None):
        self.status_code = status_code
        self._payload = payload
        self.text = text
        self.headers = headers or {}

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


class _Client:
    responses = []
    calls = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, *args, **kwargs):
        type(self).calls += 1
        return type(self).responses.pop(0)


def _client(*args, **kwargs):
    return _Client()


def _tool_payload(arguments=None):
    return {
        "choices": [{
            "message": {
                "tool_calls": [{
                    "function": {
                        "name": "start_video_production",
                        "arguments": arguments if arguments is not None else json.dumps({"title": "ok"}),
                    }
                }]
            }
        }]
    }


class ProviderLlmRetryTest(unittest.IsolatedAsyncioTestCase):
    async def _call(self):
        with patch.object(providers, "_client", _client), patch.object(providers.asyncio, "sleep", AsyncMock()):
            return await providers._post_llm_json_with_retry({"messages": []})

    async def test_transient_http_and_malformed_tool_arguments_retry_once(self):
        _Client.calls = 0
        _Client.responses = [
            _Response(503, {"error": "busy"}, "busy"),
            _Response(200, _tool_payload()),
        ]
        result = await self._call()
        self.assertEqual("start_video_production", result["choices"][0]["message"]["tool_calls"][0]["function"]["name"])
        self.assertEqual(2, _Client.calls)

        _Client.calls = 0
        _Client.responses = [
            _Response(200, _tool_payload('{"title":')),
            _Response(200, _tool_payload()),
        ]
        await self._call()
        self.assertEqual(2, _Client.calls)

    async def test_two_empty_messages_are_retried_before_a_usable_tool_call(self):
        _Client.calls = 0
        _Client.responses = [
            _Response(200, {"choices": [{"message": {}}]}),
            _Response(200, {"choices": [{"message": {"content": ""}}]}),
            _Response(200, _tool_payload()),
        ]

        result = await self._call()

        self.assertEqual(3, _Client.calls)
        self.assertEqual(
            "start_video_production",
            result["choices"][0]["message"]["tool_calls"][0]["function"]["name"],
        )

    async def test_auth_and_permanent_quota_errors_do_not_retry(self):
        for response in (
            _Response(401, {"error": "invalid token"}, "invalid token"),
            _Response(429, {"error": "insufficient quota"}, "insufficient quota"),
        ):
            with self.subTest(status=response.status_code):
                _Client.calls = 0
                _Client.responses = [response, _Response(200, _tool_payload())]
                with self.assertRaises(providers.ProviderError):
                    await self._call()
                self.assertEqual(1, _Client.calls)

    def test_seedance_payload_adds_text_negative_once_without_director_explanation(self):
        prompt = "真实办公室中人物快速整理资料，镜头自然推进。"
        payload = providers.SeedanceVideo.build_payload(prompt, "9:16")
        submitted = payload["content"][0]["text"]
        self.assertIn(providers._SEEDANCE_TEXT_NEGATIVE, submitted)
        self.assertEqual(1, submitted.count(providers._SEEDANCE_TEXT_NEGATIVE))
        self.assertNotIn("后期", submitted)
        repeated = providers.SeedanceVideo.build_payload(submitted, "9:16")["content"][0]["text"]
        self.assertEqual(submitted, repeated)

    def test_seedance_payload_removes_narration_but_keeps_intentional_short_ui_copy(self):
        prompt = (
            "本段对应口播原文：用百度搭子做自媒体，必装的十个 Skill。\n"
            "年轻创作者在真实工作台前整理相机、手机和采访素材。"
            "右侧界面按钮写着‘开始整理’，短标签清晰可读。"
        )
        submitted = providers.SeedanceVideo.build_payload(prompt, "9:16")["content"][0]["text"]
        self.assertIn("年轻创作者在真实工作台前整理相机、手机和采访素材", submitted)
        self.assertNotIn("本段对应口播原文", submitted)
        self.assertNotIn("用百度搭子做自媒体", submitted)
        self.assertIn("开始整理", submitted)
        self.assertEqual(1, submitted.count(providers._SEEDANCE_TEXT_NEGATIVE))


if __name__ == "__main__":
    unittest.main()
