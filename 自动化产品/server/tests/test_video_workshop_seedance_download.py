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

from app import providers


async def no_retry_wait(_delay: float) -> None:
    return None


class SeedanceDownloadTest(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def client_factory(handler):
        transport = httpx.MockTransport(handler)

        def factory(_timeout, follow_redirects=False):
            return httpx.AsyncClient(
                transport=transport,
            )

        return factory

    async def test_read_timeout_retries_then_atomically_replaces_target(self):
        calls = 0
        callbacks = []

        def handler(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise httpx.ReadTimeout("temporary stall", request=request)
            return httpx.Response(
                200,
                content=b"complete-video",
                headers={"Content-Length": "14"},
                request=request,
            )

        async def callback(title, detail, progress):
            callbacks.append((title, detail, progress))

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "scene.mp4"
            target.write_bytes(b"previous-good-video")
            with (
                patch.object(
                    providers,
                    "_client",
                    self.client_factory(handler),
                ),
                patch.object(
                    providers,
                    "_download_retry_sleep",
                    no_retry_wait,
                ),
            ):
                await providers._download_seedance_video(
                    "https://media.invalid/scene.mp4",
                    target,
                    callback=callback,
                    scene_number=2,
                )

            self.assertEqual(calls, 2)
            self.assertEqual(target.read_bytes(), b"complete-video")
            self.assertFalse(list(Path(tmp).glob(".*.part")))
            self.assertTrue(callbacks)
            self.assertIn("只重新下载成片", callbacks[0][1])
            self.assertIn("不会重新提交生成", callbacks[0][1])

    async def test_transient_http_error_retries_then_succeeds(self):
        calls = 0

        def handler(request):
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(
                    503,
                    json={"message": "temporary unavailable"},
                    request=request,
                )
            return httpx.Response(
                200,
                content=b"video-after-503",
                request=request,
            )

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "scene.mp4"
            with (
                patch.object(
                    providers,
                    "_client",
                    self.client_factory(handler),
                ),
                patch.object(
                    providers,
                    "_download_retry_sleep",
                    no_retry_wait,
                ),
            ):
                await providers._download_seedance_video(
                    "https://media.invalid/scene.mp4",
                    target,
                    callback=None,
                    scene_number=3,
                )

            self.assertEqual(calls, 2)
            self.assertEqual(target.read_bytes(), b"video-after-503")
            self.assertFalse(list(Path(tmp).glob(".*.part")))

    async def test_final_failure_preserves_existing_target_and_removes_part(self):
        calls = 0

        def handler(request):
            nonlocal calls
            calls += 1
            raise httpx.ReadTimeout("still stalled", request=request)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "scene.mp4"
            target.write_bytes(b"previous-good-video")
            with (
                patch.object(
                    providers,
                    "_client",
                    self.client_factory(handler),
                ),
                patch.object(
                    providers,
                    "_download_retry_sleep",
                    no_retry_wait,
                ),
            ):
                with self.assertRaisesRegex(
                    providers.ProviderError,
                    "已重试 4 次",
                ):
                    await providers._download_seedance_video(
                        "https://media.invalid/scene.mp4",
                        target,
                        callback=None,
                        scene_number=4,
                    )

            self.assertEqual(calls, 4)
            self.assertEqual(target.read_bytes(), b"previous-good-video")
            self.assertFalse(list(root.glob(".*.part")))


class HttpxCompatibilityTest(unittest.TestCase):
    def test_legacy_httpx_uses_proxies_and_allow_redirects(self):
        calls = {}
        stream_result = object()

        class LegacyAsyncClient:
            def __init__(self, *, timeout, trust_env, proxies=None):
                calls["client"] = {
                    "timeout": timeout,
                    "trust_env": trust_env,
                    "proxies": proxies,
                }

            def stream(
                self,
                method,
                url,
                *,
                headers=None,
                allow_redirects=False,
            ):
                calls["stream"] = {
                    "method": method,
                    "url": url,
                    "headers": headers,
                    "allow_redirects": allow_redirects,
                }
                return stream_result

        with (
            patch.object(providers.httpx, "AsyncClient", LegacyAsyncClient),
            patch.object(
                providers,
                "settings",
                SimpleNamespace(outbound_proxy="http://127.0.0.1:7897"),
            ),
        ):
            client = providers._client(10, follow_redirects=True)
            result = providers._stream(
                client,
                "GET",
                "https://media.invalid/video.mp4",
                follow_redirects=True,
                headers={"Accept": "video/*"},
            )

        self.assertIs(result, stream_result)
        self.assertFalse(calls["client"]["trust_env"])
        self.assertEqual(
            calls["client"]["proxies"],
            "http://127.0.0.1:7897",
        )
        self.assertTrue(calls["stream"]["allow_redirects"])


if __name__ == "__main__":
    unittest.main()
