import base64
import importlib
import io
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
        self.assertIsInstance(ref_body["images"][0], str)
        self.assertTrue(ref_body["images"][0].startswith("data:image/jpeg;base64,"))
        self.assertNotIn("input_fidelity", ref_body)

    def test_base64_image_response_is_preserved(self):
        raw = b"jpeg-result"
        encoded = base64.b64encode(raw).decode("ascii")
        result = main._image_from_response({"data": [{"b64_json": encoded}]}, "image/jpeg")
        self.assertTrue(result.startswith("data:image/jpeg;base64,"))
        self.assertEqual(base64.b64decode(result.split(",", 1)[1]), raw)

    def test_large_reference_images_are_compacted_under_shared_provider_budget(self):
        if main.Image is None:
            self.skipTest("Pillow is required for reference-image compaction")
        image = main.Image.effect_noise((2600, 1900), 100).convert("RGB")
        source = io.BytesIO()
        image.save(source, format="PNG", optimize=True)
        original = source.getvalue()
        self.assertGreater(main._image_ref_data_url_size(original, "image/png"), main.IMAGE_REFERENCE_MAX_DATA_URL_BYTES)

        refs, changed = main._compact_image_ref_files([
            ("reference-a.png", original, "image/png"),
            ("reference-b.png", original, "image/png"),
            ("reference-c.png", original, "image/png"),
        ])

        self.assertEqual(len(refs), 3)
        self.assertEqual(changed, 3)
        self.assertLessEqual(
            sum(main._image_ref_data_url_size(blob, mime) for _, blob, mime in refs),
            main.IMAGE_REFERENCE_TOTAL_DATA_URL_BYTES,
        )
        for _, blob, mime in refs:
            self.assertEqual(mime, "image/jpeg")
            self.assertLessEqual(main._image_ref_data_url_size(blob, mime), main.IMAGE_REFERENCE_MAX_DATA_URL_BYTES)

    def test_tiny_reference_logos_are_upscaled_for_provider_transport_only(self):
        if main.Image is None:
            self.skipTest("Pillow is required for tiny-reference normalization")
        image = main.Image.new("RGBA", (174, 60), (255, 255, 255, 0))
        source = io.BytesIO()
        image.save(source, format="PNG")

        blob, mime, changed = main._normalize_small_image_reference(
            source.getvalue(),
            "image/png",
        )

        self.assertTrue(changed)
        self.assertEqual(mime, "image/jpeg")
        with main.Image.open(io.BytesIO(blob)) as normalized:
            self.assertGreaterEqual(min(normalized.size), 256)
            self.assertAlmostEqual(
                normalized.size[0] / normalized.size[1],
                174 / 60,
                delta=0.02,
            )

    def test_overwide_reference_is_padded_with_transport_margin_without_crop(self):
        if main.Image is None:
            self.skipTest("Pillow is required for narrow-reference normalization")
        image = main.Image.new("RGB", (1280, 273), (17, 91, 173))
        source = io.BytesIO()
        image.save(source, format="WEBP", lossless=True)

        blob, mime, changed = main._normalize_small_image_reference(
            source.getvalue(),
            "image/webp",
        )

        self.assertTrue(changed)
        self.assertEqual(mime, "image/jpeg")
        with main.Image.open(io.BytesIO(blob)) as normalized:
            self.assertLessEqual(
                max(normalized.size) / min(normalized.size),
                3.0,
            )
            self.assertEqual(normalized.size[0], 1280)
            self.assertGreater(normalized.size[1], 273)
            center = normalized.getpixel((normalized.size[0] // 2, normalized.size[1] // 2))
            self.assertLess(sum(abs(center[i] - value) for i, value in enumerate((17, 91, 173))), 18)

    def test_multiple_maas_references_remain_native_transport_entries(self):
        if main.Image is None:
            self.skipTest("Pillow is required for multi-reference transport")
        refs = []
        colors = [(220, 30, 30), (30, 180, 30), (30, 30, 220), (180, 90, 20)]
        for index, color in enumerate(colors):
            image = main.Image.new("RGB", (320 + index * 40, 120 + index * 30), color)
            source = io.BytesIO()
            image.save(source, format="PNG")
            refs.append((f"reference-{index}.png", source.getvalue(), "image/png"))

        transport, logical_count = main._prepare_maas_reference_transport(refs)

        self.assertEqual(logical_count, 4)
        self.assertEqual(transport, refs)

    def test_maas_body_uses_native_string_array_without_openai_edit_fields(self):
        refs = [
            ("one.png", b"one", "image/png"),
            ("two.jpg", b"two", "image/jpeg"),
        ]

        body = main._maas_image_body("prompt", "custom-imagemodel-gt", "1:1", refs)

        self.assertEqual(len(body["images"]), 2)
        self.assertTrue(all(isinstance(value, str) for value in body["images"]))
        self.assertTrue(body["images"][0].startswith("data:image/png;base64,"))
        self.assertTrue(body["images"][1].startswith("data:image/jpeg;base64,"))
        self.assertNotIn("input_fidelity", body)

    def test_canvas_timeout_error_is_readable_and_does_not_expose_provider_url(self):
        error = main.HTTPException(
            502,
            detail={
                "message": "无法连接图片 API (https://provider.invalid/***) : ReadTimeout",
                "code": "IMAGE_PROVIDER_RESULT_UNKNOWN",
                "retryable": True,
                "providerCalled": True,
            },
        )
        message = main._custom_canvas_background_error(error)
        self.assertIn("可重试失败项", message)
        self.assertNotIn("provider.invalid", message)
        self.assertNotIn("{'message'", message)

    def test_reference_compaction_has_an_ffmpeg_fallback_without_pillow(self):
        if main.Image is None:
            self.skipTest("The fallback path is already active without Pillow")
        if not main.shutil.which("ffmpeg"):
            self.skipTest("ffmpeg is required for fallback coverage")
        image = main.Image.effect_noise((1800, 1400), 100).convert("RGB")
        source = io.BytesIO()
        image.save(source, format="PNG", optimize=True)
        with patch.object(main, "Image", None):
            blob, mime, changed = main._compact_image_reference(
                source.getvalue(),
                "image/png",
                700_000,
            )
        self.assertTrue(changed)
        self.assertEqual(mime, "image/jpeg")
        self.assertLessEqual(main._image_ref_data_url_size(blob, mime), 700_000)


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
