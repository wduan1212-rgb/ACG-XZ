import importlib
import sys
import unittest
from pathlib import Path

from fastapi.testclient import TestClient


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


class StaticCachePolicyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)

    def assert_immutable(self, path: str):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        self.assertEqual(
            response.headers.get("cache-control"),
            "public, max-age=31536000, immutable",
        )
        self.assertNotIn("pragma", response.headers)

    def assert_no_cache(self, path: str):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, path)
        self.assertEqual(
            response.headers.get("cache-control"),
            "no-store, no-cache, must-revalidate, max-age=0",
        )
        self.assertEqual(response.headers.get("pragma"), "no-cache")

    def test_release_versioned_main_and_video_assets_are_immutable(self):
        self.assert_immutable("/js/main.js?v=cache-policy-test")
        self.assert_immutable("/styles/base.css?v=cache-policy-test")
        self.assert_immutable("/custom-video/assets/app.js?v=cache-policy-test")

    def test_next_static_build_assets_are_immutable_without_query_token(self):
        main_chunks = sorted(
            (main.CUSTOM_CANVAS_DIR / "_next" / "static" / "chunks").glob("main-*.js")
        )
        self.assertTrue(main_chunks, "infinite-canvas main chunk is missing")
        self.assert_immutable(
            "/XZ-Design/" + main_chunks[0].relative_to(main.CUSTOM_CANVAS_DIR).as_posix()
        )
        self.assert_immutable(
            "/XZ-Design/_next/static/media/723e11e5093b8e80.p.woff2"
        )

    def test_html_and_unversioned_assets_never_receive_long_cache(self):
        self.assert_no_cache("/")
        self.assert_no_cache("/XZ-Design/")
        self.assert_no_cache("/XZ-Design/index.html?v=still-not-immutable")
        self.assert_no_cache("/js/main.js")
        self.assert_no_cache("/custom-video/assets/app.js")
        self.assert_no_cache("/logo.png")

    def test_missing_versioned_asset_is_not_cached_as_immutable(self):
        response = self.client.get("/js/does-not-exist.js?v=cache-policy-test")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn("immutable", response.headers.get("cache-control", ""))


if __name__ == "__main__":
    unittest.main()
