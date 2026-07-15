import base64
import importlib
import sys
import unittest
from unittest.mock import AsyncMock, patch
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


class ImageMaasRoutingTest(unittest.TestCase):
    def test_endpoint_depends_on_reference_images(self):
        configured = "maas-base/v1/aiart/gtimage"
        self.assertTrue(main._maas_endpoint_for_refs(configured, False).endswith("/aiart/gttext"))
        self.assertTrue(main._maas_endpoint_for_refs(configured, True).endswith("/aiart/gtimage"))

    def test_request_body_matches_expected_image_response(self):
        body = main._maas_image_body("测试提示词", "image-model", "3:4", [])
        self.assertEqual(body["response_format"], "b64_json")
        self.assertEqual(body["output_format"], "jpeg")
        self.assertEqual(body["logo_add"], 0)
        self.assertNotIn("images", body)

        ref_body = main._maas_image_body(
            "测试提示词",
            "image-model",
            "3:4",
            [("reference.jpg", b"jpeg-bytes", "image/jpeg")],
        )
        self.assertEqual(len(ref_body["images"]), 1)
        self.assertEqual(ref_body["input_fidelity"], "high")

    def test_base64_image_response_is_preserved(self):
        raw = b"jpeg-result"
        encoded = base64.b64encode(raw).decode("ascii")
        result = main._image_from_response({"data": [{"b64_json": encoded}]}, "image/jpeg")
        self.assertTrue(result.startswith("data:image/jpeg;base64,"))
        self.assertEqual(base64.b64decode(result.split(",", 1)[1]), raw)


class _FakeResponse:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self._data = data
        self.headers = {"content-type": "application/json"}
        self.text = str(data)

    def json(self):
        return self._data


class SubmitQueueRetryTest(unittest.IsolatedAsyncioTestCase):
    async def test_image_busy_response_waits_and_retries(self):
        client = type("Client", (), {})()
        client.post = AsyncMock(side_effect=[
            _FakeResponse(429, {"detail": "并发任务上限"}),
            _FakeResponse(200, {"data": [{"b64_json": "ok"}]}),
        ])
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            response, data = await main._post_json_with_retry(client, "endpoint", {}, {}, retries=2)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(client.post.await_count, 2)
        self.assertIn("data", data)

    async def test_video_busy_response_waits_and_retries(self):
        client = type("Client", (), {})()
        client.post = AsyncMock(side_effect=[
            _FakeResponse(429, {"error": "API Concurrent Limit"}),
            _FakeResponse(200, {"id": "queued-task"}),
        ])
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            response = await main._queued_video_post(client, "endpoint", retries=2, json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(client.post.await_count, 2)

    async def test_image_edit_busy_response_waits_and_retries(self):
        client = type("Client", (), {})()
        client.post = AsyncMock(side_effect=[
            _FakeResponse(429, {"detail": "rate limit"}),
            _FakeResponse(200, {"data": [{"url": "image"}]}),
        ])
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            response = await main._post_image_form_with_retry(
                client,
                "endpoint",
                data={"prompt": "测试"},
                files=[],
                headers={},
                retries=2,
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(client.post.await_count, 2)

    def test_compose_uses_a_cjk_font_family(self):
        family, _ = main._compose_subtitle_font()
        self.assertRegex(family, r"Noto Sans CJK|Source Han Sans|WenQuanYi|PingFang|Heiti")


if __name__ == "__main__":
    unittest.main()
