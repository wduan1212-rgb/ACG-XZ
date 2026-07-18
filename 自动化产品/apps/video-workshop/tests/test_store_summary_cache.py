from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import store


def project(project_id: str, name: str = "新会话") -> dict:
    return {
        "id": project_id,
        "name": name,
        "status": "conversation",
        "phase": "brief",
        "progress": 0,
        "createdAt": "2026-07-18T09:00:00+08:00",
        "updatedAt": "2026-07-18T09:00:00+08:00",
        "messages": [{"role": "user", "content": "第一条用户需求"}],
        "events": [],
        "attachments": [],
        "assets": [],
        "plan": None,
        "outputs": [],
        "error": "",
    }


class ProjectSummaryCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.projects_dir = Path(self.temp.name)
        self.settings_patch = patch.object(
            store,
            "settings",
            SimpleNamespace(projects_dir=self.projects_dir),
        )
        self.settings_patch.start()
        store._summary_cache.clear()

    def tearDown(self):
        store._summary_cache.clear()
        self.settings_patch.stop()
        self.temp.cleanup()

    def test_unchanged_project_is_not_parsed_again(self):
        path = self.projects_dir / "cached.json"
        path.write_text(json.dumps(project("cached")), encoding="utf-8")

        first = store.list_project_summaries()
        self.assertEqual(first[0]["id"], "cached")

        with patch.object(store.json, "loads", side_effect=AssertionError("reparsed")):
            second = store.list_project_summaries()
        self.assertEqual(second, first)

    def test_external_file_change_refreshes_only_changed_summary(self):
        first_path = self.projects_dir / "first.json"
        second_path = self.projects_dir / "second.json"
        first_path.write_text(json.dumps(project("first", "旧名称")), encoding="utf-8")
        second_path.write_text(json.dumps(project("second", "保持不变")), encoding="utf-8")
        store.list_project_summaries()

        first_path.write_text(
            json.dumps(project("first", "外部更新后的名称"), ensure_ascii=False),
            encoding="utf-8",
        )
        original_loads = json.loads
        parsed_payloads = []

        def tracking_loads(value):
            parsed_payloads.append(value)
            return original_loads(value)

        with patch.object(store.json, "loads", side_effect=tracking_loads):
            items = store.list_project_summaries()

        self.assertEqual(len(parsed_payloads), 1)
        by_id = {item["id"]: item for item in items}
        self.assertEqual(by_id["first"]["name"], "外部更新后的名称")
        self.assertEqual(by_id["second"]["name"], "保持不变")

    def test_save_updates_summary_cache_without_followup_json_parse(self):
        saved = store.save_project(project("saved", "保存后的名称"))
        self.assertEqual(saved["id"], "saved")

        with patch.object(store.json, "loads", side_effect=AssertionError("reparsed")):
            items = store.list_project_summaries()
        self.assertEqual(items[0]["name"], "保存后的名称")

    def test_removed_project_is_evicted_from_cache(self):
        path = self.projects_dir / "removed.json"
        path.write_text(json.dumps(project("removed")), encoding="utf-8")
        self.assertEqual(len(store.list_project_summaries()), 1)
        self.assertEqual(len(store._summary_cache), 1)

        path.unlink()
        self.assertEqual(store.list_project_summaries(), [])
        self.assertEqual(store._summary_cache, {})


if __name__ == "__main__":
    unittest.main()
