import re
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class FrontendModuleIdentityTest(unittest.TestCase):
    def _module_imports(self, module_name):
        imports = []
        pattern = re.compile(
            rf'(?:from\s+|import\()\s*["\']([^"\']*{re.escape(module_name)}(?:\?[^"\']*)?)["\']'
        )
        for path in (APP_DIR / "js").rglob("*.js"):
            source = path.read_text(encoding="utf-8")
            for specifier in pattern.findall(source):
                imports.append((path.relative_to(APP_DIR).as_posix(), specifier))
        return imports

    def test_remote_client_has_one_canonical_esm_url(self):
        imports = []
        for path in (APP_DIR / "js").rglob("*.js"):
            source = path.read_text(encoding="utf-8")
            for specifier in re.findall(r'from\s+["\']([^"\']*remote\.js(?:\?[^"\']*)?)["\']', source):
                imports.append((path.relative_to(APP_DIR).as_posix(), specifier))

        self.assertGreaterEqual(len(imports), 2)
        self.assertTrue(all("?" not in specifier for _, specifier in imports), imports)

    def test_stateful_view_modules_have_one_cache_identity(self):
        expected = {
            "studio.js": "v=20260718-v92-3",
            "prodDrawer.js": "v=20260718-v92-3",
            "orchestrator.js": "v=20260718-v92-3",
        }
        for module_name, expected_query in expected.items():
            imports = self._module_imports(module_name)
            self.assertGreaterEqual(len(imports), 2)
            queries = {specifier.partition("?")[2] for _, specifier in imports}
            self.assertEqual({expected_query}, queries, imports)

    def test_modified_stylesheets_share_current_build_identity(self):
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        for stylesheet in (
            "components.css",
            "views.css",
            "agent.css",
            "ui-motion.css",
            "custom-creation.css",
        ):
            self.assertIn(
                f"styles/{stylesheet}?v=20260718-v92-3",
                index,
                stylesheet,
            )

    def test_supplier_link_parser_prefers_latest_pasted_url(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        self.assertIn("matches[matches.length - 1]", source)


if __name__ == "__main__":
    unittest.main()
