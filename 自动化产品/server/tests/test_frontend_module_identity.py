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

    def test_router_has_one_canonical_esm_url(self):
        imports = self._module_imports("router.js")
        self.assertGreaterEqual(len(imports), 2)
        self.assertTrue(all("?" not in specifier for _, specifier in imports), imports)

    def test_stateful_view_modules_have_one_cache_identity(self):
        expected = {
            "studio.js": "v=20260813-v1431-creation-queue-stability-1",
            "prodDrawer.js": "v=20260813-v1431-creation-queue-stability-1",
            "deliveryView.js": "v=20260813-v1431-creation-queue-stability-1",
            "supplierViews.js": "v=20260813-v1431-creation-queue-stability-1",
            "draftsView.js": "v=20260813-v1431-creation-queue-stability-1",
            "chainWorkshop.js": "v=20260813-v1431-creation-queue-stability-1",
            "orchestrator.js": "v=20260813-v1431-creation-queue-stability-1",
        }
        for module_name, expected_query in expected.items():
            imports = self._module_imports(module_name)
            self.assertGreaterEqual(len(imports), 2)
            queries = {specifier.partition("?")[2] for _, specifier in imports}
            self.assertEqual({expected_query}, queries, imports)

    def test_llm_client_and_consumers_share_current_cache_identity(self):
        expected = {
            "llm.js": "v=20260727-v118-7",
            "ai.js": "v=20260813-v1431-creation-queue-stability-1",
        }
        for module_name, expected_query in expected.items():
            imports = self._module_imports(module_name)
            self.assertGreaterEqual(len(imports), 2)
            queries = {specifier.partition("?")[2] for _, specifier in imports}
            self.assertEqual({expected_query}, queries, imports)

    def test_shared_ui_components_have_one_cache_identity(self):
        imports = self._module_imports("components.js")
        self.assertGreaterEqual(len(imports), 2)
        queries = {specifier.partition("?")[2] for _, specifier in imports}
        self.assertEqual({"v=20260813-v1431-creation-queue-stability-1"}, queries, imports)

    def test_custom_publish_is_loaded_with_the_current_module_identity(self):
        source = (APP_DIR / "js/views/customCreation.js").read_text(encoding="utf-8")
        self.assertIn('import("./customPublish.js?v=20260813-v1431-creation-queue-stability-1")', source)

    def test_modified_stylesheets_share_current_build_identity(self):
        index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        expected_versions = {
            "base.css": "v=20260813-v1431-creation-queue-stability-1",
            "components.css": "v=20260813-v1431-creation-queue-stability-1",
            "views.css": "v=20260813-v1431-creation-queue-stability-1",
            "agent.css": "v=20260813-v1431-creation-queue-stability-1",
            "ui-motion.css": "v=20260813-v1431-creation-queue-stability-1",
            "custom-creation.css": "v=20260813-v1431-creation-queue-stability-1",
            "client-download.css": "v=20260727-v119-4",
        }
        for stylesheet, version in expected_versions.items():
            self.assertIn(
                f"styles/{stylesheet}?{version}",
                index,
                stylesheet,
            )

    def test_overview_summary_row_sits_above_full_width_trend_chart(self):
        source = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        self.assertIn(
            "grid-template-rows: minmax(210px, .62fr) minmax(260px, 1.38fr);",
            source,
        )
        self.assertIn(
            ".overview-summary-grid { min-height: 0; display: grid; "
            "grid-template-columns: minmax(180px, .7fr) minmax(180px, .7fr) minmax(250px, 1.25fr);",
            source,
        )
        self.assertIn(
            ".overview-remark-preview { display: grid; grid-template-rows: auto minmax(0, 1fr); }",
            source,
        )
        self.assertIn(
            ".overview-trend-card { display: grid; grid-template-rows: auto minmax(0, 1fr); }",
            source,
        )

    def test_overview_metrics_are_rendered_beside_each_content_row(self):
        source = (APP_DIR / "js/views/overview.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        self.assertIn('class="overview-task-metrics"', source)
        self.assertIn(
            ".overview-task-row.has-metrics { grid-template-columns: "
            "minmax(0, 1fr) auto auto;",
            styles,
        )
        self.assertIn(
            ".overview-task-row.has-metrics .overview-task-metrics "
            "{ grid-column: 1 / -1;",
            styles,
        )

    def test_supplier_link_parser_prefers_latest_pasted_url(self):
        source = (APP_DIR / "js/views/deliveryView.js").read_text(encoding="utf-8")
        self.assertIn("matches[matches.length - 1]", source)


if __name__ == "__main__":
    unittest.main()
