import tempfile
import unittest
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))
from test_store_tombstone import load_isolated_store


APP_DIR = Path(__file__).resolve().parents[2]


class PublishTagsTest(unittest.TestCase):
    def test_shared_tags_are_normalized_and_case_insensitively_deduplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            first = store.create_publish_tag("  百度   搭子  ", "member-a")
            duplicate = store.create_publish_tag("百度 搭子", "member-b")
            second = store.create_publish_tag("AI 办公", "member-b")

            self.assertEqual(first["label"], "百度 搭子")
            self.assertEqual(duplicate["id"], first["id"])
            self.assertEqual(
                [item["label"] for item in store.list_publish_tags("member-a")],
                ["百度 搭子", "AI 办公"],
            )
            self.assertEqual(second["createdBy"], "member-b")

    def test_publish_ui_uses_shared_select_and_server_endpoints(self):
        components = (APP_DIR / "js/ui/components.js").read_text(encoding="utf-8")
        remote = (APP_DIR / "js/core/remote.js").read_text(encoding="utf-8")
        main = (APP_DIR / "server/main.py").read_text(encoding="utf-8")

        self.assertIn('<select class="input" id="pubProductTag" required>', components)
        self.assertIn("data-publish-tag-add", components)
        self.assertIn("remote.publishTags.list()", components)
        self.assertIn("remote.publishTags.create(label)", components)
        self.assertIn('req("/api/publish-tags")', remote)
        self.assertIn('@app.get("/api/publish-tags")', main)
        self.assertIn('@app.post("/api/publish-tags")', main)


if __name__ == "__main__":
    unittest.main()
