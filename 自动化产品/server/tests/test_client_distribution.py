import hashlib
import json
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

try:
    from .. import main
except ImportError:
    import main


APP_DIR = Path(__file__).resolve().parents[2]


class ClientDistributionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.manifest = json.loads(
            (APP_DIR / "downloads/client/manifest.json").read_text(encoding="utf-8")
        )

    def test_manifest_is_public_no_store_metadata_only(self):
        response = self.client.get("/downloads/client/manifest.json")
        self.assertEqual(200, response.status_code)
        self.assertEqual("0.2.0", response.json()["latestVersion"])
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertNotIn("token", response.text.lower())
        self.assertNotIn("cookie", response.text.lower())

    def test_installers_are_fixed_allowlisted_immutable_downloads(self):
        expected = {
            "macos": "d9d8e9b9f0e0585aaa409b91dc5e078e1fa903dea384f0a119fd09757d06b632",
            "windows": "2c3668c1d5e4f5c5dd49cb2374e330056203464c95cf125e1308885d7d1e477f",
        }
        for platform, sha256 in expected.items():
            package = self.manifest["platforms"][platform]
            path = APP_DIR / "downloads/client/0.2.0" / package["filename"]
            self.assertTrue(path.is_file())
            self.assertEqual(sha256, hashlib.sha256(path.read_bytes()).hexdigest())
            response = self.client.head(package["downloadUrl"])
            self.assertEqual(200, response.status_code)
            self.assertEqual(str(path.stat().st_size), response.headers["content-length"])
            self.assertIn("attachment", response.headers["content-disposition"])
            self.assertIn("immutable", response.headers["cache-control"])
            self.assertEqual("nosniff", response.headers["x-content-type-options"])

        self.assertEqual(
            404,
            self.client.head("/downloads/client/0.2.0/not-allowlisted.zip").status_code,
        )

    def test_sidebar_entry_is_isolated_from_business_navigation(self):
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        source = (APP_DIR / "js/ui/clientDistribution.js").read_text(encoding="utf-8")
        main_source = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        entry = index.split('id="clientRailEntry"', 1)[1].split('data-nav="settings"', 1)[0]
        self.assertNotIn("data-nav", entry)
        self.assertIn("clientDistribution.js?v=20260728-v120-shell-9", main_source)
        self.assertIn('new CustomEvent("client-distribution:open")', main_source)
        self.assertIn('document.addEventListener("client-distribution:open"', source)
        self.assertNotIn("../core/store.js", source)
        self.assertNotIn("../core/remote.js", source)
        self.assertIn("__ACG_XZ_DESKTOP_GUARD__", source)
        self.assertIn("__ACG_XZ_DESKTOP__", source)
        self.assertIn('label: "客户端"', source)
        self.assertIn('label: "刷新平台"', source)
        self.assertIn('label: "发现新版本"', source)
        desktop_detection = source.split(
            "export function detectDesktopClient", 1
        )[1].split("export function resolveClientEntryState", 1)[0]
        self.assertNotIn("userAgent", desktop_detection)
        self.assertNotIn("screen", desktop_detection)

    def test_unsigned_install_guides_are_explicit(self):
        source = (APP_DIR / "js/ui/clientDistribution.js").read_text(encoding="utf-8")
        self.assertIn("隐私与安全性", source)
        self.assertIn("仍要打开", source)
        self.assertIn("SmartScreen", source)
        self.assertIn("更多信息", source)
        self.assertIn("仍要运行", source)
        self.assertIn("若失败，直接再次点击即可", source)
        self.assertNotIn("下载失败或需要重试", source)
        self.assertNotIn("client-retry-link", source)
        self.assertNotIn('<code title="SHA-256">', source)
        self.assertNotIn("平台网页功能会随刷新自动更新", source)
        styles = (APP_DIR / "styles/client-download.css").read_text(encoding="utf-8")
        self.assertIn(".client-rail-flyout::before", styles)
        self.assertIn("width: 10px", styles)
        self.assertNotIn("overflow-y: auto", styles)


if __name__ == "__main__":
    unittest.main()
